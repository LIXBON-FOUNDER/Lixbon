import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { codexTerm, decodeTermData, encodeTermData, isNeedsAck, policyArgs, CODEX_TERM_COMMANDS, CODEX_TERM_EVENTS, TERM_DATA_ENCODING } from './codexTermContract';
import { createMockCodexTerm, MOCK_CODEX_TERM_WARNINGS } from './mockCodexTerm';
import { CodexLaunchPanel, ACK_LABEL } from './CodexLaunchPanel';
import { CodexTerminal, exitText } from './CodexTerminal';
import { useCodexTermStore } from './codexTermStore';
import { CodexTermArea } from './CodexTabs';
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
    onOutput: (id, fn) => m.listen(CODEX_TERM_EVENTS.output, (e) => { if (e.payload.term_id === id) fn(decodeTermData(e.payload.data)); }),
    onExit: (id, fn) => m.listen(CODEX_TERM_EVENTS.exit, (e) => { if (e.payload.term_id === id) fn(e.payload.code); }),
  };
}

/** xterm falso: guarda lo escrito y deja simular teclas. */
function fakeTerms() {
  const made = [];
  const create = async () => {
    const t = { written: '', cols: 0, rows: 0, disposed: false, dataFn: null,
      open: vi.fn(), write(s) { this.written += s; }, resize(c, r) { this.cols = c; this.rows = r; },
      onData(fn) { this.dataFn = fn; }, dispose() { this.disposed = true; } };
    made.push(t);
    return { term: t, fit: { proposeDimensions: () => ({ cols: 90, rows: 30 }) } };
  };
  return { made, create };
}

const codex = normalizeProvider(MOCK_CODEX);
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => useCodexTermStore.setState({ tabs: [], activeKey: null, launcher: false }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.mocked(invoke).mockReset(); vi.mocked(listen).mockReset(); });

describe('contrato codex_term_*', () => {
  it('nombres, datos en texto como el PTY de los agentes y needs_ack', () => {
    expect(CODEX_TERM_COMMANDS).toEqual({ policy: 'codex_term_policy', open: 'codex_term_open', write: 'codex_term_write', resize: 'codex_term_resize', close: 'codex_term_close' });
    expect(CODEX_TERM_EVENTS).toEqual({ output: 'codex-term-output', exit: 'codex-term-exit' });
    expect(TERM_DATA_ENCODING).toBe('text');
    expect(decodeTermData('a\x1b[0mb')).toBe('a\x1b[0mb');
    expect(decodeTermData(undefined)).toBe('');
    expect(encodeTermData('\r')).toBe('\r');
    expect(isNeedsAck(new Error('needs_ack: confirma'))).toBe(true);
    expect(isNeedsAck('otro error')).toBe(false);
    expect(policyArgs({ cwd: 'C:/r', model: '', effort: ' ' })).toEqual({ cwd: 'C:/r' });
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
    expect(screen.getByTestId('codex-policy').textContent).toContain('workspace-write');
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

describe('pestaña de terminal de Codex', () => {
  it('dos pestañas aisladas por term_id; escribe, ajusta tamaño (mín. 200) y al salir deshabilita la entrada', async () => {
    const m = createMockCodexTerm();
    const api = apiOver(m);
    const a = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/a', acknowledged: true });
    const b = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/b', acknowledged: true });
    const { made, create } = fakeTerms();
    useCodexTermStore.getState().addTab(a, { cwd: 'C:/a' });
    useCodexTermStore.getState().addTab(b, { cwd: 'C:/b' });
    render(<CodexTermArea api={api} createTerminal={create} />);
    await flush(); await flush();
    expect(made).toHaveLength(2);
    m.emit(CODEX_TERM_EVENTS.output, { term_id: a.term_id, data: 'solo-A' });
    m.emit(CODEX_TERM_EVENTS.output, { term_id: b.term_id, data: 'solo-B' });
    expect(made[0].written).toContain('solo-A');
    expect(made[0].written).not.toContain('solo-B');
    expect(made[1].written).toContain('solo-B');
    expect(made[1].written).not.toContain('solo-A');
    expect(api.resize).toHaveBeenCalledWith(a.term_id, 200, 30);
    expect(made[0].cols).toBe(200);
    made[0].dataFn('x');
    expect(api.write).toHaveBeenCalledWith(a.term_id, 'x');
    // Solo la activa (la última) se ve.
    expect(screen.getByTestId(`codex-term-${a.term_id}`).style.display).toBe('none');
    expect(screen.getByTestId(`codex-term-${b.term_id}`).style.display).toBe('');
    await act(async () => { m.emit(CODEX_TERM_EVENTS.exit, { term_id: a.term_id, code: 3 }); });
    expect(made[0].written).toContain(exitText(3));
    expect(screen.getByTestId(`codex-exit-${a.term_id}`).textContent).toContain('código 3');
    expect(useCodexTermStore.getState().tabs[0]).toMatchObject({ exited: true, code: 3 });
    expect(useCodexTermStore.getState().tabs[1].exited).toBe(false);
    api.write.mockClear();
    made[0].dataFn('y');
    expect(api.write).not.toHaveBeenCalled();
  });
  it('cerrar la pestaña y desmontar llaman a codex_term_close de su term_id', async () => {
    const m = createMockCodexTerm();
    const api = apiOver(m);
    const a = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/a', acknowledged: true });
    const b = await m.invoke(CODEX_TERM_COMMANDS.open, { cwd: 'C:/b', acknowledged: true });
    const { made, create } = fakeTerms();
    const ka = useCodexTermStore.getState().addTab(a, { cwd: 'C:/a' });
    useCodexTermStore.getState().addTab(b, { cwd: 'C:/b' });
    const { unmount } = render(<CodexTermArea api={api} createTerminal={create} />);
    await flush(); await flush();
    act(() => useCodexTermStore.getState().closeTab(ka));
    expect(api.close).toHaveBeenCalledWith(a.term_id);
    expect(api.close).not.toHaveBeenCalledWith(b.term_id);
    expect(made[0].disposed).toBe(true);
    unmount();
    expect(api.close).toHaveBeenCalledWith(b.term_id);
    expect(m.terms.get(a.term_id).open).toBe(false);
    expect(m.terms.get(b.term_id).open).toBe(false);
  });
  it('desmontar antes de que el xterm esté listo también cierra y no deja oyentes', async () => {
    const m = createMockCodexTerm();
    const api = apiOver(m);
    const { create } = fakeTerms();
    const { unmount } = render(<CodexTerminal tab={{ term_id: 'codex-x' }} api={api} createTerminal={create} />);
    unmount();
    expect(api.close).toHaveBeenCalledWith('codex-x');
  });
});
