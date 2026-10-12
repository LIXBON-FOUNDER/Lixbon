// Frontera del frente UI/ADE: lo que el cimiento NO puede hacer ni tocar.
// Estas pruebas leen el código fuente del ADE y fallan si alguien conecta algo real o importa un archivo caliente.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(ADE, '../..');

function archivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? archivos(p) : [p];
  });
}
const codigo = archivos(ADE).filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.(js|jsx)$/.test(f) && !f.includes(`${'testing'}`));
const leer = (f) => readFileSync(f, 'utf8');
const rel = (f) => relative(ADE, f).replace(/\\/g, '/');

describe('el ADE no conecta nada real', () => {
  it('ningún archivo del ADE usa invoke, orch_call, fetch, WebSocket ni importa Tauri', () => {
    const prohibido = /@tauri-apps|\binvoke\s*\(|orch_call|\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest|EventSource/;
    const malos = codigo.filter((f) => {
      const sinComentarios = leer(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return prohibido.test(sinComentarios);
    }).map(rel);
    expect(malos).toEqual([]);
  });

  it('solo importa de fuera del ADE lo permitido y en modo lectura', () => {
    const permitidos = [
      /orch\/agent\/AgentChip$/, /orch\/agent\/ProviderMark$/, /orch\/agent\/agentIdentity$/, /orch\/terminalApprovalContract$/,
      /components\/Icons$/, /styles\/(base|studio)\.css$/,
    ];
    const salientes = [];
    for (const f of codigo) {
      for (const m of leer(f).matchAll(/from\s+'(\.[^']+)'|import\s+'(\.[^']+)'/g)) {
        const destino = resolve(dirname(f), m[1] || m[2]);
        if (!destino.startsWith(ADE)) salientes.push({ f: rel(f), destino: relative(resolve(DESKTOP, 'src'), destino).replace(/\\/g, '/') });
      }
    }
    const fuera = salientes.filter((s) => !permitidos.some((re) => re.test(s.destino)));
    expect(fuera).toEqual([]);
    expect(salientes.length).toBeGreaterThan(0);
  });

  it('no importa los archivos calientes de otros slices (stores, OrchestratorMode, Tauri)', () => {
    const calientes = /store\/(orchStore|appStore)|OrchestratorMode|useAttention|orch\/attention|src-tauri/;
    const malos = codigo.filter((f) => calientes.test(leer(f).split('\n').filter((l) => /^\s*import\b|from\s+'/.test(l)).join('\n'))).map(rel);
    expect(malos).toEqual([]);
  });

  it('no duplica reglas de dominio del frontend vigente (attention.js, canIntegrate.js) fuera del núcleo simulado', () => {
    const sospechosos = codigo.filter((f) => !f.includes(`${'mock'}`) && !f.includes('fieldSources') && /reviewStatus|isReviewAccepted|attentionItems\(|canIntegrate\(/.test(leer(f).replace(/\/\/.*$/gm, ''))).map(rel);
    expect(sospechosos).toEqual([]);
  });
});

describe('la vista previa está aislada del build de producción', () => {
  it('ade-preview.html no figura entre las entradas de vite.config.js (el build solo toma index, team y mascota)', () => {
    const vite = leer(resolve(DESKTOP, 'vite.config.js'));
    expect(vite).not.toMatch(/ade-preview/);
    expect(vite).toMatch(/index\.html/);
    expect(existsSync(resolve(DESKTOP, 'ade-preview.html'))).toBe(true);
  });

  it('la entrada de la vista previa no monta App ni los stores existentes', () => {
    const lineas = leer(resolve(ADE, 'preview/main.jsx')).split(String.fromCharCode(10));
    const main = lineas.filter((l) => /^\s*import/.test(l)).join(' ');
    expect(main).not.toMatch(/from\s+'(\.\.\/)+App'|appStore|orchStore/);
    expect(leer(resolve(DESKTOP, 'ade-preview.html'))).toMatch(/src\/ade\/preview\/main\.jsx/);
  });

  it('App.jsx y main.jsx del IDE no conocen el ADE (no se integra en este frente)', () => {
    for (const f of ['src/App.jsx', 'src/main.jsx']) expect(leer(resolve(DESKTOP, f)), f).not.toMatch(/\/ade\//);
  });
});
