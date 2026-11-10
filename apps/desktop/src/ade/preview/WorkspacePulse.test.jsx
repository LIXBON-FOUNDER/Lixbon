import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { PreviewSidebar } from './PreviewSidebar';
import { usePreviewStore } from './previewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const store = () => usePreviewStore.getState();
const rows = (container) => [...container.querySelectorAll('.pv-row[data-attempt-id]')];
const row = (container, id) => container.querySelector(`.pv-row[data-attempt-id="${id}"]`);

beforeEach(() => {
  store().resetAll();
  usePreviewStore.setState({ prefs: { followUp: 'queue', pulse: true } });
});
afterEach(cleanup);

describe('Workspace Pulse · navegador', () => {
  it('resume la fila sin tocar el estado ni la Attention: cada uno conserva su sitio', () => {
    const { container } = render(<PreviewSidebar />);
    const r = row(container, 'att_mr_a'); // espera una aprobación y tiene Attention
    expect(within(r).getByText('Esperando · aprobación')).toBeTruthy();
    const pulse = within(r).getByTestId('pulse');
    expect(pulse.textContent).not.toMatch(/aprobaci|Attention|decisi/i);
    // El marcador de Attention sigue en la primera línea, fuera del Pulse.
    expect(r.querySelector('.pv-row__l1 .pv-attn')).toBeTruthy();
    expect(pulse.querySelector('.pv-attn')).toBeNull();
    expect(pulse.closest('.pv-row__l2')).toBeTruthy();
    expect(r.querySelector('.pv-row__l1').contains(pulse)).toBe(false);
  });

  it('enseña la procedencia: verificado, lo dice el agente y sin dato son tres cosas distintas', () => {
    const { container } = render(<PreviewSidebar />);
    const verified = within(row(container, 'att_oa_b')).getByTestId('pulse').querySelector('[data-pulse="tests"]');
    const reported = within(row(container, 'att_rt_b')).getByTestId('pulse').querySelector('[data-pulse="tests"]');
    expect(verified.getAttribute('data-evidence')).toBe('verified');
    expect(reported.getAttribute('data-evidence')).toBe('agent_reported');
    expect(verified.textContent).toContain('Verificado por el Core');
    expect(reported.textContent).toContain('Lo dice el agente');
    // «Listo para revisar» sin pruebas ni dato: guion, nunca 0.
    act(() => { store().patchAttempt('att_oa_b', { tests: null, evidence: { files: 'verified' } }); });
    const unknown = row(container, 'att_oa_b').querySelector('[data-pulse="tests"]');
    expect(unknown.getAttribute('data-evidence')).toBe('unknown');
    expect(unknown.textContent).toContain('Sin dato');
    expect(unknown.querySelector('[aria-hidden="true"]').textContent).toBe('tests —');
  });

  it('con Pulse apagado la fila vuelve a la línea de antes, y el interruptor lo anuncia', () => {
    const { container } = render(<PreviewSidebar />);
    expect(container.querySelectorAll('[data-testid="pulse"]').length).toBeGreaterThan(5);
    fireEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    const toggle = screen.getByRole('button', { name: 'Pulse' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll('[data-testid="pulse"]').length).toBe(0);
    // La referencia sin Pulse sigue diciendo estado · minutos (y proveedor en las filas de una sola Task).
    expect(row(container, 'att_rt_a').querySelector('.pv-row__l2').textContent).toContain('18 min');
    expect(row(container, 'att_rt_a').querySelector('.pv-row__l2').textContent).not.toContain('tests');
    expect(row(container, 'att_mr_a').querySelector('.pv-row__l2').textContent).toMatch(/Gemini/);
  });

  it('cada fila es un único botón: alcanzable con Tab y sin controles anidados ni regiones en vivo', () => {
    const { container } = render(<PreviewSidebar />);
    for (const r of rows(container)) {
      expect(r.tagName).toBe('BUTTON');
      expect(r.querySelector('button, a, input, [tabindex]')).toBeNull();
      expect(r.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    }
  });

  it('el lector de pantalla recibe el texto completo de cada señal, no el recorte visual', () => {
    const { container } = render(<PreviewSidebar />);
    const r = row(container, 'att_rt_a');
    const spoken = [...r.querySelectorAll('.pv-pulse2 .pv-sr')].map((n) => n.textContent).join(' ');
    expect(spoken).toContain('Lleva 18 min');
    // Las pruebas no caben en la línea (el estado «Ejecutando una orden» ocupa casi todo) pero el lector las oye igual.
    expect([...r.querySelectorAll('.pv-pulse2__seg')].some((s) => s.dataset.pulse === 'tests')).toBe(false);
    expect(spoken).toContain('Pruebas: 141 de 141 pasan. Verificado por el Core');
    expect(spoken).toContain('Archivos cambiados: 9. Verificado por el Core');
    // Y el tooltip de la fila enseña el resumen completo a quien pasa el ratón.
    expect(r.getAttribute('title')).toContain('Pruebas: 141 de 141 pasan. Verificado por el Core');
    // Lo visible se oculta al lector para no leerlo dos veces.
    expect([...r.querySelectorAll('.pv-pulse2__seg > [aria-hidden="true"]')].length).toBeGreaterThan(0);
  });

  it('un evento de fondo cambia el texto de la fila pero no mueve filas, no cambia el orden ni roba el foco', () => {
    const { container } = render(<PreviewSidebar />);
    const before = rows(container).map((r) => r.getAttribute('data-attempt-id'));
    const target = row(container, 'att_oa_a');
    target.focus();
    expect(document.activeElement).toBe(target);
    const heightBefore = target.querySelectorAll('.pv-row__l2').length;
    act(() => {
      store().patchAttempt('att_oa_a', { minutes: 19, files: 11, state: 'waiting', cause: 'approval' });
      store().patchAttempt('att_rt_a', { state: 'review_ready' });
    });
    expect(rows(container).map((r) => r.getAttribute('data-attempt-id'))).toEqual(before);
    expect(row(container, 'att_oa_a')).toBe(target); // el mismo nodo: no se remontó
    expect(document.activeElement).toBe(target);
    expect(target.querySelectorAll('.pv-row__l2').length).toBe(heightBefore); // sigue siendo una sola línea de resumen
    expect(target.textContent).toContain('Esperando · aprobación');
    expect(target.textContent).toContain('19 min');
  });

  it('un cambio de Pulse no cambia la selección ni mueve la vista', () => {
    const { container } = render(<PreviewSidebar />);
    const sel = store().sel;
    act(() => { store().patchAttempt('att_oa_b', { minutes: 7, tests: { pass: 140, total: 141 } }); });
    expect(store().sel).toEqual(sel);
    expect(row(container, 'att_oa_b').textContent).toContain('7 min');
  });
});

describe('Workspace Pulse · Workspace denso', () => {
  it('con 40 filas más, todas siguen en una línea de resumen y sin porcentajes', () => {
    const { container } = render(<PreviewSidebar />);
    const base = rows(container).length;
    act(() => { store().denseCase(40); });
    const all = rows(container);
    expect(all.length).toBeGreaterThanOrEqual(base + 40);
    for (const r of all) {
      expect(r.querySelectorAll('.pv-row__l1').length).toBe(1);
      expect(r.querySelectorAll('.pv-row__l2').length).toBe(1);
    }
    const text = all.map((r) => r.querySelector('.pv-row__l2').textContent).join('\n');
    expect(text).not.toMatch(/%/);
  });

  it('en el denso lo desconocido siempre es un guion con su texto y nunca un cero', () => {
    const { container } = render(<PreviewSidebar />);
    act(() => { store().denseCase(50); });
    const unknown = [...container.querySelectorAll('[data-evidence="unknown"]')];
    expect(unknown.length).toBeGreaterThan(5);
    for (const u of unknown) {
      expect(u.querySelector('[aria-hidden="true"]').textContent).toMatch(/^(archivos|tests) —$/);
      expect(u.textContent).toContain('Sin dato');
    }
    // Ninguna señal con respaldo conocido enseña un cero.
    const known = [...container.querySelectorAll('[data-evidence="verified"], [data-evidence="agent_reported"]')];
    expect(known.length).toBeGreaterThan(10);
    for (const k of known) expect(k.querySelector('[aria-hidden="true"]').textContent).not.toMatch(/(^|\s)0(\s|\/|$)/);
  });

  it('las variantes working, waiting, review, failed y final aparecen todas en el denso', () => {
    const { container } = render(<PreviewSidebar />);
    act(() => { store().denseCase(40); });
    const variants = new Set([...container.querySelectorAll('[data-testid="pulse"]')].map((p) => p.getAttribute('data-variant')));
    expect([...variants].sort()).toEqual(['failed', 'final', 'review', 'waiting', 'working']);
  });

  it('el caso denso se limita a 10–50 filas y reiniciar la simulación lo deshace', () => {
    const { container } = render(<PreviewSidebar />);
    const base = rows(container).length;
    act(() => { store().denseCase(500); });
    expect(rows(container).length).toBe(base + 50);
    act(() => { store().resetAll(); });
    expect(rows(container).length).toBe(base);
    act(() => { store().denseCase(1); });
    expect(rows(container).length).toBe(base + 10);
  });

  it('el caso denso es determinista: dos veces dan las mismas filas', () => {
    const snapshot = () => {
      store().resetAll();
      store().denseCase(30);
      return JSON.stringify(store().attempts.filter((a) => a.id.startsWith('att_dense')));
    };
    expect(snapshot()).toBe(snapshot());
  });

  it('las Tasks con dos Intentos siguen siendo un grupo y su Pulse no repite el proveedor del título', () => {
    const { container } = render(<PreviewSidebar />);
    act(() => { store().denseCase(40); });
    const child = container.querySelector('.pv-row--att[data-attempt-id^="att_dense"]');
    expect(child).toBeTruthy();
    expect(child.querySelector('[data-pulse="provider"]')).toBeNull();
  });
});
