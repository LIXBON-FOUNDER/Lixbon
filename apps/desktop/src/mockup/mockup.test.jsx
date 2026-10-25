// mockup.test.jsx — humo de la maqueta unificada: reglas del estado simulado + que cada superficie monte y reaccione.
// No toca el Core ni el producto: todo es el store en memoria de src/mockup.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
import { useStore, attemptById } from './store';
import { runCommand } from './cli/CliTerminal';
import Showcase from './Showcase';
import Composer from './ade/Composer';
import AdeDesktop from './ade/AdeDesktop';
import IdeDesktop from './ide/IdeDesktop';
import MobileApp from './mobile/MobileApp';

globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };

const st = () => useStore.getState();
const att = (id) => attemptById(st(), id);

beforeEach(() => { vi.useFakeTimers(); st().resetAll(); useStore.setState({ surface: 'all', view: 'workspace' }); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); });
vi.setConfig({ testTimeout: 60000 });

describe('estado simulado — composer', () => {
  it('Queue añade al dock con su procedencia y no interrumpe', () => {
    const before = st().pending.att_rt_a.length;
    st().send({ attemptId: 'att_rt_a', text: 'add tests', mode: 'queue', from: 'CLI' });
    const p = st().pending.att_rt_a;
    expect(p).toHaveLength(before + 1);
    expect(p.at(-1)).toMatchObject({ mode: 'queue', from: 'CLI', text: 'add tests' });
    expect(att('att_rt_a').state).toBe('working');
  });

  it('Steer se aplica en un punto seguro y sale del dock', () => {
    st().send({ attemptId: 'att_rt_a', text: 'keep SQLite', mode: 'steer' });
    expect(st().pending.att_rt_a.at(-1).applying).toBe(true);
    act(() => { vi.advanceTimersByTime(2700); });
    expect(st().pending.att_rt_a.some((p) => p.text === 'keep SQLite')).toBe(false);
    expect(st().timelines.att_rt_a.some((e) => e.delivered === 'steer')).toBe(true);
  });

  it('un proveedor sin Steer nativo degrada a Queue de forma explícita (no finge)', () => {
    st().patchAttempt('att_sb_a', { state: 'working', phase: 'thinking' });
    st().send({ attemptId: 'att_sb_a', text: 'x', mode: 'steer' });
    expect(st().pending.att_sb_a.at(-1).mode).toBe('queue');
    expect(st().toasts.some((t) => /no native Steer/i.test(t.text))).toBe(true);
  });

  it('Stop & Send detiene, avisa que lo escrito no se revierte y reenvía', () => {
    st().send({ attemptId: 'att_rt_a', text: 'new direction', mode: 'stop' });
    expect(att('att_rt_a').state).toBe('paused');
    expect(st().timelines.att_rt_a.at(-1).text).toMatch(/not reverted/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(att('att_rt_a').state).toBe('working');
    expect(st().timelines.att_rt_a.some((e) => e.delivered === 'stop')).toBe(true);
  });

  it('reordenar, convertir y borrar pendientes', () => {
    const [a, b] = st().pending.att_rt_a;
    st().movePending('att_rt_a', b.id, -1);
    expect(st().pending.att_rt_a[0].id).toBe(b.id);
    st().convertPending('att_rt_a', a.id);
    expect(st().pending.att_rt_a.find((p) => p.id === a.id).mode).toBe('steer');
    st().removePending('att_rt_a', b.id);
    expect(st().pending.att_rt_a.some((p) => p.id === b.id)).toBe(false);
  });

  it('Fork crea un Attempt paralelo con su worktree, mismo ContextPackage y sin tocar el origen', () => {
    const src = { ...att('att_rt_a') };
    const id = st().fork({ attemptId: 'att_rt_a', provider: 'gpt', model: 'GPT-5', host: 'vps', text: 'try another way' });
    const f = att(id);
    expect(f).toMatchObject({ label: 'C', state: 'starting', ctx: src.ctx, host: 'vps', forkOf: 'att_rt_a' });
    expect(f.branch).toBe('feat/agent-runtime-gpt');
    expect(f.worktree).toContain(id);
    expect(att('att_rt_a').state).toBe(src.state);
    expect(st().sel.attemptId).toBe(id);
    act(() => { vi.advanceTimersByTime(1700); });
    expect(att(id).state).toBe('working');
  });

  it('un Attempt ocioso recibe un Send normal y vuelve a trabajar', () => {
    st().send({ attemptId: 'att_rt_b', text: 'fix windows paths' });
    expect(att('att_rt_b').state).toBe('working');
    expect(st().pending.att_rt_b).toBeUndefined();
  });

  it('endTurn entrega el primer pendiente; sin pendientes → Review ready con Attention', () => {
    st().endTurn('att_rt_a');
    expect(st().pending.att_rt_a).toHaveLength(1);
    st().endTurn('att_rt_a'); st().endTurn('att_rt_a');
    expect(att('att_rt_a').state).toBe('review_ready');
    expect(st().attention.some((x) => x.attemptId === 'att_rt_a' && x.kind === 'review')).toBe(true);
  });
});

describe('estado simulado — Attention, hosts, take over, review', () => {
  it('permiso: aprobar desde Mobile reanuda y deja rastro; denegar re-rutea', () => {
    st().requestPermission('att_rt_a');
    const x = st().attention.find((i) => i.attemptId === 'att_rt_a' && i.kind === 'permission');
    expect(att('att_rt_a').state).toBe('waiting');
    expect(st().push).toBeTruthy();
    st().resolveAttention(x.id, 'allow_once', { from: 'Mobile' });
    expect(att('att_rt_a')).toMatchObject({ state: 'working', phase: 'tool' });
    expect(st().timelines.att_rt_a.at(-1).text).toMatch(/Approved once from Mobile/);
    expect(st().push).toBeNull();
    const y = st().attention.find((i) => i.id === 'at_net_ch');
    st().resolveAttention(y.id, 'deny', { from: 'CLI' });
    expect(att('att_ch_a').phase).toBe('thinking');
  });

  it('Take Over pausa al agente y Return to Agent actualiza el ContextPackage', () => {
    const ctx = att('att_rt_a').ctx;
    st().takeOver('att_rt_a');
    expect(att('att_rt_a')).toMatchObject({ state: 'paused', control: 'human' });
    st().returnToAgent('att_rt_a', 'finish tests');
    expect(att('att_rt_a')).toMatchObject({ state: 'working', control: 'agent' });
    expect(att('att_rt_a').ctx).not.toBe(ctx);
  });

  it('un host offline pausa su trabajo y crea Attention; al volver se reanuda', () => {
    st().toggleHost('macbook');
    expect(att('att_mig_a').state).toBe('failed');
    expect(att('att_mr_a').state).toBe('offline');
    expect(st().attention.some((x) => x.kind === 'host' && x.title.startsWith('MacBook'))).toBe(true);
    st().toggleHost('macbook');
    expect(att('att_mr_a').state).toBe('working');
    expect(st().attention.some((x) => x.kind === 'host' && x.title.startsWith('MacBook'))).toBe(false);
  });

  it('Review: comentarios acumulados → UN paquete; accept apunta a la revisión', () => {
    st().addComment('att_oa_b', 'src/auth/token.ts', 42, 'use a timeout');
    st().addComment('att_oa_b', 'src/auth/store.ts', 13, 'why keychain?');
    st().sendReview('att_oa_b');
    const ev = st().timelines.att_oa_b.at(-1);
    expect(ev.delivered).toBe('review');
    expect(ev.comments).toHaveLength(2);
    expect(st().review('att_oa_b').round).toBe(2);
    expect(att('att_oa_b').state).toBe('working');
    st().decide('att_inv_a', 'accepted');
    expect(att('att_inv_a')).toMatchObject({ state: 'completed', reviewVerdict: 'accepted' });
  });

  it('createTask crea Task + Attempt A que arranca', () => {
    const id = st().createTask({ projectId: 'sgi', title: 'Rate limit', provider: 'codex', host: 'desktop', objective: 'x' });
    expect(att(id)).toMatchObject({ label: 'A', state: 'starting' });
    act(() => { vi.advanceTimersByTime(1600); });
    expect(att(id).state).toBe('working');
  });
});

describe('CLI — mismo modelo, mismo estado', () => {
  it('lxo send escribe en la cola del Composer con procedencia CLI', () => {
    runCommand('lxo send runtime "also add edge cases" --queue', st());
    expect(st().pending.att_rt_a.at(-1)).toMatchObject({ text: 'also add edge cases', from: 'CLI' });
  });
  it('lxo attention resolve respeta el riesgo alto', () => {
    const r = runCommand('lxo attention resolve net_ch --allow-once', st());
    render(<div>{r.out}</div>);
    expect(screen.getByText(/High-risk approval needs an explicit confirmation/i)).toBeTruthy();
    expect(st().attention.some((x) => x.id === 'at_net_ch')).toBe(true);
  });
  it('lxo status usa los mismos estados que el resto', () => {
    const r = runCommand('lxo status', st());
    const { container } = render(<div>{r.out}</div>);
    expect(container.textContent).toMatch(/working:tool/);
    expect(container.textContent).toMatch(/waiting:approval|review_ready/);
  });
  it('Stop & Send desde CLI pide --yes', () => {
    const r = runCommand('lxo send runtime "x" --stop', st());
    render(<div>{r.out}</div>);
    expect(screen.getByText(/--yes/)).toBeTruthy();
    expect(att('att_rt_a').state).toBe('working');
  });
});

describe('superficies', () => {
  it('Composer: Enter = Queue con el agente ocupado; Ctrl+Enter = Steer; Ctrl+Shift+Enter abre confirmación', () => {
    render(<Composer attemptId="att_rt_a" />);
    const ta = screen.getByLabelText('Instruction');
    const n0 = st().pending.att_rt_a.length;
    fireEvent.change(ta, { target: { value: 'one' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(st().pending.att_rt_a).toHaveLength(n0 + 1);
    fireEvent.change(ta, { target: { value: 'two' } });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(st().pending.att_rt_a.at(-1).mode).toBe('steer');
    fireEvent.change(ta, { target: { value: 'three' } });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(st().overlay).toMatchObject({ type: 'confirmstop', text: 'three' });
    expect(screen.getByText(/Enter adds this after the current turn/)).toBeTruthy();
  });

  it('Composer ocioso: dice "Send" y no ofrece Queue', () => {
    render(<Composer attemptId="att_rt_b" />);
    expect(screen.getByText(/Enter sends a new turn/)).toBeTruthy();
    expect(screen.queryByText(/after current turn/)).toBeNull();
  });

  it('ADE: el sidebar comprime 1 Attempt y expande N; Attention separada del estado', () => {
    render(<AdeDesktop />);
    const tree = screen.getByRole('tree');
    expect(within(tree).getByText('Mobile Remote')).toBeTruthy(); // 1 Attempt → fila de Task
    expect(within(tree).getAllByTitle(/attempts/i).length).toBeGreaterThanOrEqual(2); // Agent Runtime + OAuth Refresh
    expect(screen.getAllByText(/9 need you/).length).toBeGreaterThanOrEqual(1);
  });

  it('ADE: cambiar de Attempt actualiza cabecera y no cambia por eventos de fondo', () => {
    render(<AdeDesktop />);
    const before = st().sel.attemptId;
    act(() => { st().simulate('att_pk_a', { state: 'failed' }); st().requestPermission('att_sch_a'); });
    expect(st().sel.attemptId).toBe(before);
    fireEvent.click(screen.getAllByText('Linux Packaging')[0]);
    expect(st().sel.attemptId).toBe('att_pk_a');
  });

  it('Fork desde el diálogo crea el Attempt y lo selecciona', () => {
    render(<AdeDesktop />);
    act(() => st().openFork('att_oa_a'));
    fireEvent.click(screen.getByRole('button', { name: /Start Attempt C/ }));
    expect(st().attempts.filter((a) => a.taskId === 't_oauth')).toHaveLength(3);
  });

  it('IDE: la barra de contexto muestra Task, Attempt, branch, worktree, host y agente', () => {
    render(<IdeDesktop />);
    const bar = screen.getByRole('region', { name: /Task, Attempt, branch, worktree, agent and host/ });
    expect(bar.textContent).toMatch(/Agent Runtime/);
    expect(bar.textContent).toMatch(/feat\/agent-runtime/);
    expect(bar.textContent).toMatch(/Desktop-PC/);
    expect(bar.textContent).toMatch(/att_rt_a/);
  });

  it('IDE: Take Over → banner "You are driving" → Return to Agent', () => {
    render(<IdeDesktop />);
    fireEvent.click(screen.getByRole('button', { name: /Take Over/ }));
    expect(screen.getByText(/You are driving/)).toBeTruthy();
    expect(att('att_rt_a').control).toBe('human');
  });

  it('Mobile: aprobar con contexto completo y reflejarlo en el estado compartido', () => {
    render(<MobileApp />);
    act(() => { st().requestPermission('att_rt_a'); });
    const x = st().attention.find((i) => i.attemptId === 'att_rt_a' && i.kind === 'permission');
    act(() => st().mOpen('approval', { id: x.id }));
    expect(screen.getAllByText('Permission required').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('npm install better-sqlite3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(att('att_rt_a').state).toBe('working');
    expect(screen.getByText(/Decision sent/)).toBeTruthy();
  });

  it('Mobile: una aprobación de riesgo alto exige confirmar que se leyó el comando', () => {
    render(<MobileApp />);
    act(() => st().mOpen('approval', { id: 'at_net_ch' }));
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(allow.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Allow for this Attempt/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(allow.disabled).toBe(false);
  });

  it.each(['all', 'ade', 'ide', 'mobile', 'cli', 'flow', 'guide'])('el showcase monta la superficie "%s" sin errores', (surface) => {
    useStore.setState({ surface });
    const { container } = render(<Showcase />);
    expect(container.querySelector('.show__stage').textContent.length).toBeGreaterThan(40);
  });

  it('las vistas del ADE montan (Attention, Compare, Proof Pack, Review, Hosts, Usage, Map)', () => {
    useStore.setState({ surface: 'ade', sel: { projectId: 'lixbon', taskId: 't_oauth', attemptId: 'att_oa_b' } });
    for (const view of ['attention', 'compare', 'proof', 'review', 'hosts', 'usage', 'map']) {
      act(() => st().setView(view));
      const { container, unmount } = render(<AdeDesktop />);
      expect(container.querySelector('.ade__main').textContent.length).toBeGreaterThan(30);
      unmount();
    }
  });
});
