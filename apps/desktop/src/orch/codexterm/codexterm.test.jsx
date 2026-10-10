import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { codexTerm, policyText, normalizeBuffer, normalizeListItem, seqOf, appendCapped, acceptSeq, TRUNCATE_RESET, decodeTermData, encodeTermData, isNeedsAck, policyArgs, CODEX_TERM_COMMANDS, CODEX_TERM_EVENTS, TERM_DATA_ENCODING } from './codexTermContract';
import { createMockCodexTerm, MOCK_CODEX_TERM_WARNINGS } from './mockCodexTerm';
import { CodexLaunchPanel, ACK_LABEL } from './CodexLaunchPanel';
import { CodexTerminal, exitText } from './CodexTerminal';
import { useCodexTermStore, configureCodexTerm } from './codexTermStore';
import { CodexTermArea, CodexTabList } from './CodexTabs';
import { MOCK_CODEX } from '../providers/mockListProviders';
import { normalizeProvider } from '../providers/providersContract';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

/** Adaptador sobre un mock aislado (mismo filtrado por term_id que el real). */
function apiOver(m) {
  return {
    policy: (a) => m.invoke(CODEX_TERM_COMMANDS.policy, policyArgs(a)),
    open: ({ cols, rows, acknowledged, ...a }) => m.invoke(CODEX_TERM_COMMANDS.open, { ...policyArgs(a), cols, rows, acknowledged: acknowledged === true }),
    write: vi.fn((id, t) => m.invoke(CODEX_TERM_COMMANDS.write, { term_id: id, data: encodeTermData(t) })),
    resize: vi.fn((id, cols, rows) => m.invoke(CODEX_TERM_COMMANDS.resize, { term_id: id, cols, rows })),
    close: vi.fn((id) => m.invoke(CODEX_TERM_COMMANDS.close, { term_id: id })),
    buffer: vi.fn(async (id) => { try { return normalizeBuffer(await m.invoke(CODEX_TERM_COMMANDS.buffer, { term_id: id })); } catch { return null; } }),
    redraw: vi.fn((id) => m.invoke(CODEX_TERM_COMMANDS.redraw, { term_id: id })),
    list: async () => (await m.invoke(CODEX_TERM_COMMANDS.list, {})).map(normalizeListItem).filter(Boolean),
    onAnyOutput: (fn) => m.listen(CODEX_TERM_EVENTS.output, (e) => fn(e.payload.term_id, decodeTermData(e.payload.data), seqOf(e.payload.seq))),
    onAnyExit: (fn) => m.listen(CODEX_TERM_EVENTS.exit, (e) => fn(e.payload.term_id, e.payload.code ?? null)),
  };
}

/** xterm falso: guarda lo escrito y deja simular teclas. */
function fakeTerms() {
  const made = [];
  const create = async () => {
    const t = { written: '', cols: 0, rows: 0, disposed: false, dataFn: null, ops: [],
      open: vi.fn(), reset() { this.ops.push('reset'); this.written = ''; },
      write(s) { this.ops.push(`write:${s}`); this.written += s; }, resize(c, r) { this.ops.push(`resize:${c}x${r}`); this.cols = c; this.rows = r; },
      onData(fn) { this.dataFn = fn; }, dispose() { this.disposed = true; } };
    made.push(t);
    return { term: t, fit: { proposeDimensions: () => ({ cols: 90, rows: 30 }) } };
  };
  return { made, create };
}

const codex = normalizeProvider(MOCK_CODEX);
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => { configureCodexTerm(null); useCodexTermStore.setState({ tabs: [], activeKey: null, launcher: false, buffers: {} }); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.mocked(invoke).mockReset(); vi.mocked(listen).mockReset(); });

describe('contrato codex_term_*', () => {
  it('nombres, datos en texto como el PTY de los agentes y needs_ack', () => {
    expect(CODEX_TERM_COMMANDS).toEqual({ policy: 'codex_term_policy', open: 'codex_term_open', write: 'codex_term_write', resize: 'codex_term_resize', close: 'codex_term_close', buffer: 'codex_term_buffer', redraw: 'codex_term_redraw', list: 'codex_term_list' });
    expect(normalizeBuffer({ data: '\x1b[0mhola', seq: 7, cols: 200, rows: 40, alt_screen: true })).toEqual({ data: '\x1b[0mhola', seq: 7, cols: 200, rows: 40, alt_screen: true });
    expect(normalizeBuffer({ seq: 1 })).toBeNull();
    expect(normalizeListItem({ term_id: 't', cwd: 'C:/r', model: 'gpt-6-sol', effort: null, policy: { status: 'ok' }, argv: ['codex'], exited: true, code: 2 })).toEqual({ term_id: 't', cwd: 'C:/r', model: 'gpt-6-sol', effort: null, policy: { status: 'ok' }, argv: ['codex'], exited: true, code: 2 });
    expect(normalizeListItem({ term_id: 't' })).toMatchObject({ model: null, effort: null, argv: [] });
    expect(normalizeListItem({ cwd: 'x' })).toBeNull();
    expect(CODEX_TERM_EVENTS).toEqual({ output: 'codex-term-output', exit: 'codex-term-exit' });
    expect(TERM_DATA_ENCODING).toBe('text');
    expect(decodeTermData('a\x1b[0mb')).toBe('a\x1b[0mb');
    expect(decodeTermData(undefined)).toBe('');
    expect(encodeTermData('\r')).toBe('\r');
    expect(isNeedsAck(new Error('needs_ack: confirma'))).toBe(true);
    expect(isNeedsAck('otro error')).toBe(false);
    expect(policyArgs({ cwd: 'C:/r', model: '', effort: ' ' })).toEqual({ cwd: 'C:/r' });
  });
  it('policy del host es un objeto: se muestra como texto, nunca crudo', () => {
    expect(policyText({ provider: 'codex', profile: 'terminal', cli_version: '0.162.1', model: 'gpt-6-sol', effort: 'high', interactive: true, status: 'ok' }))
      .toBe('Terminal interactiva · Codex 0.162.1 · modelo: gpt-6-sol · esfuerzo: high · lista');
    expect(policyText('texto')).toBe('texto');
    expect(policyText(null)).toBe('');
  });
  it('mock como build() del host: -m para el modelo y -c model_reasoning_effort', async () => {
    const m = createMockCodexTerm();
    const p = await m.invoke(CODEX_TERM_COMMANDS.policy, { cwd: 'C:/r', model: 'gpt-6-sol', effort: 'high' });
    expect(p.argv).toEqual(['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--cd', 'C:/r', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high']);
    expect(p.policy).toMatchObject({ provider: 'codex', profile: 'terminal', model: 'gpt-6-sol', effort: 'high', interactive: true });
  });
  it('sin VITE_ORCH_MOCK llama al host con snake_case y acknowledged booleano', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '');
    vi.mocked(invoke).mockResolvedValue({ term_id: 't1' });
    await codexTerm.open({ cwd: 'C:/r', model: 'gpt-6-sol', cols: 200, rows: 40 });
    expect(invoke).toHaveBeenCalledWith('codex_term_open', { cwd: 'C:/r', model: 'gpt-6-sol', cols: 200, rows: 40, acknowledged: false });
    await codexTerm.write('t1', 'ls\r');
    expect(invoke).toHaveBeenCalledWith('codex_term_write', { term_id: 't1', data: 'ls\r' });
    await codexTerm.resize('t1', 200, 30);
    expect(invoke).toHaveBeenCalledWith('codex_term_resize', { term_id: 't1', cols: 200, rows: 30 });
  });
  it('el adaptador real filtra los eventos por term_id', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '');
    const hs = [];
    vi.mocked(listen).mockImplementation(async (ev, h) => { hs.push([ev, h]); return () => {}; });
    const got = [];
    await codexTerm.onOutput('a', (t) => got.push(t));
    hs[0][1]({ payload: { term_id: 'b', data: 'de b' } });
    hs[0][1]({ payload: { term_id: 'a', data: 'de a' } });
    expect(hs[0][0]).toBe('codex-term-output');
    expect(got).toEqual(['de a']);
  });
});

describe('panel previo a abrir Codex', () => {
  it('muestra política, argv y avisos antes de abrir; sin confirmar no se abre', async () => {
    const m = createMockCodexTerm();
    const api = apiOver(m);
    const openSpy = vi.spyOn(api, 'open');
    const onOpened = vi.fn();
    render(<CodexLaunchPanel cwd="C:/repo" codex={codex} api={api} onOpened={onOpened} />);
    expect(await screen.findByTestId('codex-argv')).toBeTruthy();
    expect(screen.getByTestId('codex-argv').textContent).toBe('codex --sandbox workspace-write --ask-for-approval on-request --cd C:/repo');
    expect(screen.getByTestId('codex-policy').textContent).toBe('Terminal interactiva · Codex 0.162.1 · modelo: el que defina config.toml · sin verificar');
    for (const w of MOCK_CODEX_TERM_WARNINGS) expect(screen.getByText(w)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
    const btn = screen.getByRole('button', { name: 'Abrir' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(openSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: ACK_LABEL }));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith({ cwd: 'C:/repo', model: '', effort: '', cols: 200, rows: 40, acknowledged: true });
    expect(onOpened.mock.calls[0][0].term_id).toMatch(/^codex-mock-/);
  });
  it('sandbox elevado (e3572e5): el aviso de Delegar sale en el panel y exige confirmación', async () => {
    const { WARN_ELEVATED_RW } = await import('../providers/mockListProviders');
    const m = createMockCodexTerm({ windowsSandbox: 'elevated' });
    await expect(m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/r', cols: 200, rows: 40, acknowledged: false })).rejects.toThrow(/^needs_ack/);
    const api = apiOver(m);
    const onOpened = vi.fn();
    render(<CodexLaunchPanel cwd="C:/repo" codex={codex} api={api} onOpened={onOpened} />);
    expect(await screen.findByText(WARN_ELEVATED_RW)).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Abrir' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: ACK_LABEL }));
    fireEvent.click(btn);
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(onOpened.mock.calls[0][0].warnings).toContain(WARN_ELEVATED_RW);
    // Sin elevated no aparece.
    expect((await createMockCodexTerm().invoke(CODEX_TERM_COMMANDS.policy, { cwd: 'C:/r' })).warnings).not.toContain(WARN_ELEVATED_RW);
  });

  it('si el host responde needs_ack, no abre, lo dice y desmarca la casilla', async () => {
    const api = { policy: async () => ({ policy: 'x', argv: ['codex'], warnings: ['aviso'] }), open: vi.fn(async () => { throw new Error('needs_ack'); }) };
    const onOpened = vi.fn();
    render(<CodexLaunchPanel cwd="C:/repo" codex={codex} api={api} onOpened={onOpened} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: ACK_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect((await screen.findByRole('alert')).textContent).toContain('confirmar los avisos');
    expect(onOpened).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: ACK_LABEL }).checked).toBe(false);
  });
  it('sin avisos no hay casilla y se abre con acknowledged false; modelo y esfuerzo van al argv', async () => {
    const api = { policy: vi.fn(async (a) => ({ policy: null, argv: ['codex', ...(a.model ? ['--model', a.model] : [])], warnings: [] })), open: vi.fn(async () => ({ term_id: 't9', argv: [], warnings: [] })) };
    const onOpened = vi.fn();
    render(<CodexLaunchPanel cwd="C:/repo" codex={codex} api={api} onOpened={onOpened} />);
    await screen.findByTestId('codex-argv');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByTitle('Modelo de Codex'));
    fireEvent.click(screen.getByText('GPT-6-Sol'));
    await waitFor(() => expect(screen.getByTestId('codex-argv').textContent).toBe('codex --model gpt-6-sol'));
    expect(api.policy).toHaveBeenLastCalledWith({ cwd: 'C:/repo', model: 'gpt-6-sol', effort: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ acknowledged: false, model: 'gpt-6-sol' })));
  });
  it('sin carpeta: no pide política ni deja abrir', async () => {
    const api = { policy: vi.fn(), open: vi.fn() };
    render(<CodexLaunchPanel cwd="" codex={codex} api={api} onOpened={vi.fn()} />);
    expect(screen.getByTestId('codex-cwd').textContent).toContain('Abre una carpeta');
    expect(api.policy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Abrir' }).disabled).toBe(true);
  });
});

describe('pestaña de terminal de Codex (PTY a nivel de app)', () => {
  async function setup(n = 2, opts) {
    const m = createMockCodexTerm();
    const api = apiOver(m);
    configureCodexTerm(api, opts);
    const opened = [];
    for (let i = 0; i < n; i += 1) {
      const r = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: `C:/r${i}`, acknowledged: true, cols: 200, rows: 40 });
      opened.push(r);
      useCodexTermStore.getState().addTab(r, { cwd: `C:/r${i}` });
    }
    await flush();
    return { m, api, opened };
  }

  it('dos pestañas aisladas por term_id; escribe, ajusta tamaño (mín. 200) y al salir deshabilita la entrada', async () => {
    const { m, api, opened: [a, b] } = await setup(2);
    const { made, create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush(); await flush();
    expect(made).toHaveLength(2);
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'solo-A' });
    m.emit(CODEX_TERM_EVENTS.output, { term_id: b.term_id, data: 'solo-B' });
    expect(made[0].written).toContain('solo-A');
    expect(made[0].written).not.toContain('solo-B');
    expect(made[1].written).toContain('solo-B');
    expect(made[1].written).not.toContain('solo-A');
    expect(api.resize).toHaveBeenCalledWith(a.term_id, 200, 30);
    made[0].dataFn('x');
    expect(api.write).toHaveBeenCalledWith(a.term_id, 'x');
    expect(screen.getByTestId(`codex-term-${a.term_id}`).style.display).toBe('none');
    await act(async () => { m.emit(CODEX_TERM_EVENTS.exit, { term_id: a.term_id, code: 3 }); });
    expect(made[0].written).toContain(exitText(3));
    expect(screen.getByTestId(`codex-exit-${a.term_id}`).textContent).toContain('código 3');
    expect(useCodexTermStore.getState().tabs[1].exited).toBe(false);
    api.write.mockClear();
    made[0].dataFn('y');
    expect(api.write).not.toHaveBeenCalled();
  });

  it('cambiar de modo y volver: el PTY no se cierra, la salida mientras no había vista se repinta entera', async () => {
    const { m, api, opened: [a] } = await setup(1);
    const first = fakeTerms();
    const { unmount } = render(<CodexTermArea createTerminal={first.create} />);
    await flush(); await flush();
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'uno\r\n' });
    unmount(); // p. ej. pasar del modo Agente al Editor
    expect(api.close).not.toHaveBeenCalled();
    expect(m.terms.get(a.term_id).open).toBe(true);
    // Mientras no hay vista, la salida sigue llegando al store.
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'dos\r\n' });
    expect(useCodexTermStore.getState().buffers[a.term_id].data).toContain('dos');
    const again = fakeTerms();
    render(<CodexTermArea createTerminal={again.create} />);
    await flush(); await flush();
    const t = again.made[0];
    // Orden del host: reset, resize al tamaño del búfer, data (empieza con \x1b[0m).
    expect(t.ops[0]).toBe('reset');
    // El tamaño que tenía el PTY (la primera vista lo dejó en 200x30).
    expect(t.ops[1]).toBe('resize:200x30');
    expect(t.ops[2].startsWith('write:\x1b[0m')).toBe(true);
    expect(t.written).toContain('uno');
    expect(t.written).toContain('dos');
    expect(api.redraw).not.toHaveBeenCalled();
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'tres' });
    expect(t.written.endsWith('tres')).toBe(true);
  });

  it('seq: los eventos con seq <= el del búfer no se repiten; sin seq se aceptan', async () => {
    expect(acceptSeq(5, 5)).toBe(false);
    expect(acceptSeq(6, 5)).toBe(true);
    expect(acceptSeq(null, 5)).toBe(true);
    expect(acceptSeq(3, null)).toBe(true);
    const { m, opened: [a] } = await setup(1);
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'A' });   // seq 2 (el 1 es el saludo)
    const { made, create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush(); await flush();
    // El host reenvía (p. ej. por reconexión) eventos ya incluidos en el búfer.
    m.emitRaw(CODEX_TERM_EVENTS.output, { term_id: a.term_id, seq: 2, data: 'REPETIDO' });
    m.emitRaw(CODEX_TERM_EVENTS.output, { term_id: a.term_id, seq: 3, data: 'NUEVO' });
    m.emitRaw(CODEX_TERM_EVENTS.output, { term_id: a.term_id, seq: 3, data: 'OTRA-VEZ' });
    expect(made[0].written).not.toContain('REPETIDO');
    expect(made[0].written).toContain('NUEVO');
    expect(made[0].written).not.toContain('OTRA-VEZ');
    expect(useCodexTermStore.getState().buffers[a.term_id].data).not.toContain('REPETIDO');
  });

  it('sin codex_term_buffer: repinta con el búfer de respaldo y pide un codex_term_redraw', async () => {
    const { m, api, opened: [a] } = await setup(1);
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'respaldo' });
    api.buffer.mockResolvedValue(null);
    const { made, create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush(); await flush();
    expect(made[0].ops[0]).toBe('reset');
    expect(made[0].written).toContain('respaldo');
    expect(api.redraw).toHaveBeenCalledTimes(1);
    expect(api.redraw).toHaveBeenCalledWith(a.term_id);
  });

  it('botón Redibujar llama a codex_term_redraw de su term_id', async () => {
    const { api, opened: [a] } = await setup(1);
    const { create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush();
    fireEvent.click(screen.getByTestId(`codex-redraw-${a.term_id}`));
    expect(api.redraw).toHaveBeenCalledWith(a.term_id);
  });

  it('búfer de respaldo con tope: corta en el siguiente \\n tras el límite y antepone \\x1b[0m', async () => {
    expect(appendCapped('abc', 'def', 10)).toBe('abcdef');
    const cut = appendCapped('l1\x1b[31mrojo\nl2\nl3', 'x', 12);
    expect(cut).toBe(`${TRUNCATE_RESET}l2\nl3x`);
    expect(cut.startsWith('\x1b[0m')).toBe(true);
    // Sin \n: no empieza a mitad de un par sustituto.
    expect(appendCapped('aaa😀b', '', 2)).toBe(`${TRUNCATE_RESET}b`);
    expect(appendCapped('aa😀bb', '', 4)).toBe(`${TRUNCATE_RESET}😀bb`);
    const { m, opened: [a] } = await setup(1, { cap: 50 });
    for (let i = 0; i < 20; i += 1) m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: `linea-${i}\n` });
    const buf = useCodexTermStore.getState().buffers[a.term_id].data;
    expect(buf.length).toBeLessThanOrEqual(50 + TRUNCATE_RESET.length);
    expect(buf.startsWith(TRUNCATE_RESET)).toBe(true);
    expect(buf.endsWith('linea-19\n')).toBe(true);
    expect(buf.slice(TRUNCATE_RESET.length)).toMatch(/^linea-\d+\n/);
  });

  it('cerrar la pestaña sí cierra el PTY (solo el suyo)', async () => {
    const { m, api, opened: [a, b] } = await setup(2);
    const { made, create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush(); await flush();
    const ka = useCodexTermStore.getState().tabs[0].key;
    act(() => useCodexTermStore.getState().closeTab(ka));
    expect(api.close).toHaveBeenCalledWith(a.term_id);
    expect(api.close).not.toHaveBeenCalledWith(b.term_id);
    expect(made[0].disposed).toBe(true);
    expect(useCodexTermStore.getState().buffers[a.term_id]).toBeUndefined();
    expect(m.terms.has(a.term_id)).toBe(false);
  });

  it('recargar la webview: codex_term_list rehace las pestañas (terminadas con su código) y cada una se repinta', async () => {
    const m = createMockCodexTerm();
    const a = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/a', model: 'gpt-6-sol', effort: 'high', acknowledged: true, cols: 210, rows: 33 });
    const b = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/b', acknowledged: true });
    await new Promise((r) => setTimeout(r, 0));
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'antes de recargar' });
    m.emit(CODEX_TERM_EVENTS.exit, { term_id: b.term_id, code: 1 });
    // Webview nueva: store vacío.
    configureCodexTerm(apiOver(m));
    useCodexTermStore.setState({ tabs: [], activeKey: null, launcher: false, buffers: {} });
    expect(await useCodexTermStore.getState().rehydrate()).toBe(2);
    const tabs = useCodexTermStore.getState().tabs;
    expect(tabs.map((t) => [t.term_id, t.cwd, t.model, t.effort, t.exited, t.code])).toEqual([[a.term_id, 'C:/a', 'gpt-6-sol', 'high', false, null], [b.term_id, 'C:/b', null, null, true, 1]]);
    expect(tabs[0].argv).toContain('-m');
    // Modelo y esfuerzo en la pestaña restaurada; nada cuando son null.
    const list = render(<CodexTabList />);
    expect(screen.getByTestId(`codex-tab-meta-${tabs[0].key}`).textContent).toBe('gpt-6-sol · high');
    expect(screen.queryByTestId(`codex-tab-meta-${tabs[1].key}`)).toBeNull();
    expect(screen.getByTestId(`codex-tab-${tabs[1].key}`).textContent).toContain('terminó (1)');
    list.unmount();
    expect(await useCodexTermStore.getState().rehydrate()).toBe(0); // no duplica
    useCodexTermStore.setState({ activeKey: tabs[0].key });
    const { made, create } = fakeTerms();
    render(<CodexTermArea createTerminal={create} />);
    await flush(); await flush();
    expect(made[0].ops.slice(0, 2)).toEqual(['reset', 'resize:210x33']);
    expect(made[0].written).toContain('antes de recargar');
    expect(made[1].written).toContain(exitText(1));
    expect(screen.getByTestId(`codex-exit-${b.term_id}`).textContent).toContain('código 1');
  });

  it('desmontar antes de que el xterm esté listo no cierra el PTY', async () => {
    const { api, opened: [a] } = await setup(1);
    const { create } = fakeTerms();
    const { unmount } = render(<CodexTerminal tab={{ term_id: a.term_id }} createTerminal={create} />);
    unmount();
    await flush();
    expect(api.close).not.toHaveBeenCalled();
  });
});
