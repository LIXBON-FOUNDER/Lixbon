import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// El compositor se adapta al ancho DEL COMPOSITOR (container query), no al de la ventana: el dock del chat puede medir ~320 px.
// jsdom no calcula layout, así que esta prueba fija el CONTRATO de las reglas: lo esencial nunca se oculta y el orden en el que
// se cede espacio es siempre el mismo.
const root = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'apps/desktop/src')].find((c) => existsSync(resolve(c, 'styles/agent.css')));
if (!root) throw new Error('No se encontró styles/agent.css');
const css = readFileSync(resolve(root, 'styles/agent.css'), 'utf8').replace(/\r\n/g, '\n');
const jsx = readFileSync(resolve(root, 'chat/ChatInputBar.jsx'), 'utf8');

const tiers = [...css.matchAll(/@container chatbar \(max-width: (\d+)px\) \{([\s\S]*?)\n\}\n/g)]
  .map(([, width, body]) => ({ width: Number(width), body: body.replace(/\/\*[\s\S]*?\*\//g, '') }));
const hidden = (body) => [...body.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)].map(([, selector]) => selector.trim());

describe('compositor responsivo', () => {
  it('el compositor es un contenedor de tamaño y su fila puede envolver en vez de recortar', () => {
    expect(css).toMatch(/\.chat-inputbar\s*\{\s*container:\s*chatbar\s*\/\s*inline-size;\s*\}/);
    expect(css).toMatch(/\.chat-inputbar__row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('Claude Code cede espacio en un orden fijo: motor, modo, % de la cuota, «@», contexto, chip del motor y, al final, el texto del effort', () => {
    const order = [...tiers].sort((a, b) => b.width - a.width).flatMap((tier) => hidden(tier.body)).filter((s) => s.includes('--claude') && !s.includes(':not('));
    expect(order.map((s) => s.replace(/^\.chat-inputbar--claude\s+/, ''))).toEqual([
      '.chat-inputbar__engine-lbl',
      '.chat-inputbar__mode-lbl',
      '.chat-inputbar__quota-pct',
      '.chat-inputbar__at',
      '.chat-inputbar__ctx',
      '.chat-inputbar__engine',
      '.effort__value',
    ]);
  });

  it('el motor propio (menos controles) cede mucho más tarde: primero el texto del modo y luego «@»', () => {
    const own = [...tiers].sort((a, b) => b.width - a.width).flatMap((tier) => hidden(tier.body).map((s) => [tier.width, s])).filter(([, s]) => s.includes(':not('));
    expect(own.map(([width, s]) => [width, s.replace(/^\.chat-inputbar:not\(\.chat-inputbar--claude\)\s+/, '')])).toEqual([
      [400, '.chat-inputbar__mode-lbl'],
      [330, '.chat-inputbar__at'],
    ]);
  });

  it('lo esencial nunca se oculta: enviar, adjuntar, modelo, effort y cuota', () => {
    const everythingHidden = tiers.flatMap((tier) => hidden(tier.body)).join(' ');
    for (const essential of ['chat-inputbar__send', 'modelpicker', 'chat-inputbar__quota ', 'chat-inputbar__quota{']) {
      expect(everythingHidden, essential).not.toContain(essential);
    }
    // El botón del effort sigue (solo pierde su texto) y «Adjuntar» es el `.ic` sin la clase del «@»: solo el «@» se oculta.
    expect(everythingHidden).not.toMatch(/\.effort(?![\w-])/);
    expect(everythingHidden).not.toMatch(/\.ic\b/);
    expect(css).toMatch(/\.chat-inputbar__send,[^{]*\.chat-inputbar__quota[^{]*\{\s*flex-shrink:\s*0/);
  });

  it('el marcado tiene los ganchos que usa el CSS y la cuota solo aparece con Claude Code', () => {
    for (const hook of ['chat-inputbar__engine-lbl', 'chat-inputbar__mode-lbl', 'chat-inputbar__at']) expect(jsx).toContain(hook);
    expect(jsx).toMatch(/\{isClaude && <ComposerQuota \/>\}/);
    // Sin el texto del modo a la vista, el botón sigue diciendo qué modo es.
    expect(jsx).toMatch(/aria-label=\{`Modo del chat: /);
  });
});
