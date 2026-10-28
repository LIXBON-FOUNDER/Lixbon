import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ContextPreview } from './ContextPreview';
import { CANONICAL_INVALID, CANONICAL_VALID, REJECTED, VARIANTS } from './testFixtures/contextPreviewFixtures';

// LXO-136 · la vista previa de un ContextPackage: refleja el paquete, distingue sus estados y no muestra nada que no deba.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

/** Escribe el texto del paquete y pulsa «Revisar»; el Core (mock) contesta con `response`. */
async function review(response, text = '{"paquete":"de prueba"}') {
  const calls = [];
  invoke.mockImplementation(async (_c, payload) => { calls.push(payload); if (response instanceof Error) throw response; return response; });
  render(<ContextPreview />);
  fireEvent.change(screen.getByTestId('context-preview-text'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('context-preview-review'));
  await flush();
  return calls;
}
const badges = () => [...screen.getByRole('list', { name: 'Estado del paquete' }).querySelectorAll('[data-badge]')].map((b) => b.getAttribute('data-badge'));

describe('ContextPreview', () => {
  it('no consulta nada al montar ni mientras no haya un paquete: solo lee cuando la persona lo pide', async () => {
    invoke.mockImplementation(async () => CANONICAL_VALID);
    render(<ContextPreview />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('context-preview-review').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('context-preview-text'), { target: { value: '   ' } });
    expect(screen.getByTestId('context-preview-review').disabled).toBe(true);
  });

  it('un paquete completo: se envía el texto tal cual, se muestra todo y se dice lo que no se pudo comprobar', async () => {
    const texto = '{ "schema_version": 1 }';
    const calls = await review(CANONICAL_VALID, texto);
    expect(calls).toEqual([{ query: 'context_package_preview', args: { package: texto } }]);
    expect(badges()).toEqual(['complete', 'attachment_not_scanned']);
    const root = screen.getByTestId('context-preview-valid');
    expect(root.getAttribute('data-completeness')).toBe('complete');

    // Verificación: identidad verificada, sin credenciales, y los adjuntos NO comprobados.
    const verif = screen.getByTestId('context-preview-verification').textContent;
    expect(verif).toContain('Identidad verificada');
    expect(verif).toContain(CANONICAL_VALID.package_id);
    expect(verif).toMatch(/Sin credenciales/);
    expect(verif).toMatch(/Adjuntos sin comprobar/);

    // Origen de solo lectura, sin ningún campo editable.
    const source = screen.getByTestId('context-preview-source');
    expect(within(source).getByText('p-lixbon')).toBeTruthy();
    expect(within(source).getByText('claude')).toBeTruthy();
    expect(within(source).getByText('fp:16e48575')).toBeTruthy();
    expect(source.querySelectorAll('input, textarea, select, button')).toHaveLength(0);
    expect(root.textContent).toMatch(/no se puede editar/);

    // Contenido tal cual.
    expect(screen.getByTestId('context-preview-objective').textContent).toBe(CANONICAL_VALID.package.objective);
    for (const decision of CANONICAL_VALID.package.decisions) expect(root.textContent).toContain(decision);
    expect(within(screen.getByTestId('context-preview-revision')).getByText(CANONICAL_VALID.package.revision.head_tree)).toBeTruthy();
    expect(within(screen.getByTestId('context-preview-files')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('context-preview-tests').textContent).toMatch(/cargo test --lib · pasan 1441 · fallan 0 · ignoradas 19/);
    expect(screen.getByTestId('context-preview-size').textContent).toMatch(/2\.1 KiB.*527 tokens.*4\.1 KiB/);

    // Qué trae y qué no.
    const sections = screen.getByTestId('context-preview-sections');
    expect(sections.querySelector('[data-section="revision"]').getAttribute('data-state')).toBe('included');
    expect(sections.querySelector('[data-section="attachments"]').textContent).toMatch(/4 de 4 viajan/);

    // Adjuntos: el bundle no se escaneó y se dice.
    const att = within(screen.getByTestId('context-preview-attachments')).getAllByRole('listitem');
    expect(att.map((a) => a.getAttribute('data-attachment-state'))).toEqual(['unscanned', 'included', 'included', 'included']);
    expect(att[0].textContent).toMatch(/Sin escanear.*git bundle/);
    expect(screen.getByTestId('context-preview-redactions').textContent).toMatch(/No se ocultó ningún valor/);
  });

  it('parcial: sin repositorio se dice por qué y no se inventa evidencia', async () => {
    await review(VARIANTS.sinRepositorio());
    expect(badges()).toEqual(['partial', 'revision_absent', 'attachment_not_scanned']);
    expect(screen.getByTestId('context-preview-valid').getAttribute('data-completeness')).toBe('partial');
    expect(screen.getByTestId('context-preview-no-revision').textContent).toMatch(/el Attempt no tiene repositorio/);
    expect(screen.queryByTestId('context-preview-revision')).toBeNull();
    expect(screen.getByTestId('context-preview-sections').querySelector('[data-section="revision"]').getAttribute('data-state')).toBe('absent');
  });

  it('truncado: el recorte se muestra explícito, con el campo y cuánto había', async () => {
    await review(VARIANTS.truncado());
    expect(badges()).toContain('truncated');
    const t = screen.getByTestId('context-preview-truncated');
    expect(t.textContent).toContain('«objective» se recortó: tenía 6000 caracteres.');
    expect(screen.getByTestId('context-preview-valid').getAttribute('data-completeness')).toBe('partial');
  });

  it('redactado: el marcador se ve como redactado, sin forma de revelarlo, y se cuenta cuántos hubo', async () => {
    await review(VARIANTS.redactado());
    expect(badges()).toContain('redacted');
    const marks = screen.getByTestId('context-preview-valid').querySelectorAll('mark.cp-redacted');
    expect(marks.length).toBe(2);
    for (const m of marks) {
      expect(m.textContent).toBe('[redactado]');
      expect(m.getAttribute('title')).toMatch(/No hay forma de verlo/);
      // Ni botón ni enlace para mostrar lo que había, ni dentro de la marca ni junto a ella.
      expect(m.querySelector('button, a, input')).toBeNull();
      expect(m.parentElement.querySelector('button, a')).toBeNull();
    }
    expect(screen.getByTestId('context-preview-redactions').textContent).toMatch(/2 valores se ocultaron.*No hay forma de verlos/);
    expect(screen.getByTestId('context-preview-valid').getAttribute('data-completeness')).toBe('complete');
  });

  it('un adjunto omitido por contener un secreto se dice, y el paquete es parcial', async () => {
    await review(VARIANTS.adjuntoOmitido());
    expect(badges()).toContain('attachment_omitted');
    const li = screen.getByTestId('context-preview-attachments').querySelector('[data-attachment-state="omitted"]');
    expect(li.textContent).toMatch(/Omitido.*credencial y no viaja/);
    expect(screen.getByTestId('context-preview-sections').querySelector('[data-section="attachments"]').getAttribute('data-state')).toBe('omitted');
  });

  it('inválido: solo el motivo, sin contenido, y un paquete alterado enseña los dos hashes', async () => {
    await review(CANONICAL_INVALID);
    const box = screen.getByTestId('context-preview-invalid');
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.getAttribute('data-code')).toBe('id_mismatch');
    expect(badges()).toEqual(['invalid']);
    expect(box.textContent).toMatch(/El paquete se alteró\./);
    expect(box.textContent).toMatch(/No se muestra su contenido/);
    const ids = screen.getByTestId('context-preview-ids').textContent;
    expect(ids).toContain(CANONICAL_INVALID.declared_id);
    expect(ids).toContain(CANONICAL_INVALID.recomputed_id);
    expect(screen.queryByTestId('context-preview-valid')).toBeNull();
    expect(screen.queryByTestId('context-preview-objective')).toBeNull();
    // El detalle técnico va plegado.
    expect(box.querySelector('details code').textContent).toMatch(/^id_mismatch: /);
  });

  it('cada motivo de rechazo del contrato se pinta con su copia y solo el de identidad trae hashes', async () => {
    for (const code of ['invalid_json', 'unsupported_version', 'missing_field', 'invalid_field', 'too_large', 'secret_detected', 'attachment_mismatch']) {
      await review(REJECTED.porCodigo(code));
      const box = screen.getByTestId('context-preview-invalid');
      expect(box.getAttribute('data-code')).toBe(code);
      expect(screen.queryByTestId('context-preview-ids')).toBeNull();
      cleanup();
      invoke.mockReset();
    }
  });

  it('una respuesta que no cumple el contrato no se pinta como un paquete', async () => {
    await review({ ...CANONICAL_VALID, verification: { identity: 'verified', secrets: 'none_found', attachments: 'verified' } });
    expect(screen.queryByTestId('context-preview-valid')).toBeNull();
    expect(screen.getByTestId('context-preview-error').textContent).toMatch(/ade_query_invalid_response|verificación/);
  });

  it('si el Core falla o el paquete es demasiado grande no se confunde con un paquete inválido', async () => {
    await review(new Error('boom'));
    expect(screen.getByTestId('context-preview-error').getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('context-preview-invalid')).toBeNull();
    cleanup();
    invoke.mockReset();
    invoke.mockImplementation(async () => CANONICAL_VALID);
    render(<ContextPreview />);
    fireEvent.change(screen.getByTestId('context-preview-text'), { target: { value: 'x'.repeat(200_000) } });
    fireEvent.click(screen.getByTestId('context-preview-review'));
    await flush();
    expect(invoke).not.toHaveBeenCalled(); // no se envía: el límite se aplica antes de molestar al Core
    expect(screen.getByTestId('context-preview-error').textContent).toMatch(/pesa más/);
  });

  it('un paquete en el tope de tamaño se pinta por tramos y rápido', async () => {
    const t0 = performance.now();
    await review(VARIANTS.enElTope());
    const files = screen.getByTestId('context-preview-files');
    expect(within(files).getAllByRole('listitem')).toHaveLength(50); // 500 archivos, pero no 500 filas de golpe
    fireEvent.click(screen.getByTestId('context-preview-files-more'));
    expect(within(screen.getByTestId('context-preview-files')).getAllByRole('listitem')).toHaveLength(100);
    expect(screen.getByTestId('context-preview-files-more').textContent).toMatch(/Mostrar 50 más \(400 sin mostrar\)/);
    expect(within(screen.getByTestId('context-preview-untracked')).getAllByRole('listitem')).toHaveLength(50);
    // Tope holgado: con la suite entera en paralelo el reloj de pared se estira; la cota real son las 50 filas.
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('leer un archivo lo carga en el cuadro de texto y avisa si es demasiado grande', async () => {
    render(<ContextPreview />);
    const input = screen.getByTestId('context-preview-file');
    const archivo = new File(['{"a":1}'], 'paquete.json', { type: 'application/json' });
    await act(async () => { fireEvent.change(input, { target: { files: [archivo] } }); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('context-preview-text').value).toBe('{"a":1}');
    expect(screen.getByTestId('context-preview-filename').textContent).toContain('paquete.json');

    const grande = new File(['x'.repeat(130 * 1024)], 'grande.json', { type: 'application/json' });
    await act(async () => { fireEvent.change(input, { target: { files: [grande] } }); await Promise.resolve(); });
    expect(screen.getByTestId('context-preview-error').textContent).toMatch(/130 KiB.*no pasa de 64 KiB/);
    expect(screen.getByTestId('context-preview-text').value).toBe('');
  });

  it('accesibilidad: controles con etiqueta, resultado anunciado y secciones con encabezados', async () => {
    await review(CANONICAL_VALID);
    const root = screen.getByTestId('context-preview');
    expect(root.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByLabelText(/Archivo del paquete/)).toBeTruthy();
    expect(screen.getByLabelText(/pega aquí su JSON/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revisar paquete' })).toBeTruthy();
    expect(root.querySelector('[aria-live="polite"]')).toBeTruthy();
    // Cada sección tiene su encabezado y su nombre accesible.
    for (const section of root.querySelectorAll('section[aria-labelledby]')) {
      expect(root.querySelector(`#${section.getAttribute('aria-labelledby')}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('heading', { level: 4 }).length).toBeGreaterThanOrEqual(8);
    // Los avisos llevan texto y glifo: no dependen solo del color.
    for (const b of root.querySelectorAll('[data-badge]')) {
      expect(b.textContent.trim().length).toBeGreaterThan(3);
      expect(b.querySelector('[aria-hidden="true"]')).toBeTruthy();
    }
    for (const list of root.querySelectorAll('ul[aria-label]')) expect(list.getAttribute('aria-label').length).toBeGreaterThan(3);
  });

  it('una respuesta vieja no pisa a una nueva (la última revisión manda)', async () => {
    let soltar;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { soltar = () => resolve(CANONICAL_INVALID); }));
    invoke.mockImplementationOnce(async () => VARIANTS.truncado());
    render(<ContextPreview />);
    fireEvent.change(screen.getByTestId('context-preview-text'), { target: { value: '{"uno":1}' } });
    fireEvent.click(screen.getByTestId('context-preview-review'));
    await flush();
    expect(screen.getByTestId('context-preview-loading')).toBeTruthy();
    fireEvent.change(screen.getByTestId('context-preview-text'), { target: { value: '{"dos":2}' } });
    fireEvent.click(screen.getByTestId('context-preview-review'));
    await flush();
    await act(async () => { soltar(); await Promise.resolve(); });
    await flush();
    expect(screen.queryByTestId('context-preview-invalid')).toBeNull();
    expect(screen.getByTestId('context-preview-valid')).toBeTruthy();
  });
});
