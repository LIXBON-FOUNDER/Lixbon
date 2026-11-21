import { afterEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from './terminalStore';
import { useAppStore } from './appStore';
import { termWrite } from '../lib/tauri';
vi.mock('../lib/tauri', () => ({ termWrite: vi.fn(async () => {}), termClose: vi.fn(async () => {}) }));
afterEach(() => { useTerminalStore.setState({ sessions: [], activeKey: null, pending: {} }); vi.clearAllMocks(); });

it('never runs in a terminal from a previous workspace and restores the matching session', () => {
  const terminals = useTerminalStore.getState();
  useAppStore.setState({ workspaceRoot: '/A' });
  const a = terminals.addSession(); terminals.setSessionId(a, 'pty-A');
  useAppStore.setState({ workspaceRoot: '/B' });
  terminals.runCommand('build');
  expect(termWrite).not.toHaveBeenCalled();
  const b = useTerminalStore.getState().sessions.find((s) => s.cwd === '/B');
  expect(useTerminalStore.getState().pending[b.key]).toBe('build');
  terminals.setSessionId(b.key, 'pty-B');
  useAppStore.setState({ workspaceRoot: '/A' });
  terminals.runCommand('test');
  expect(termWrite).toHaveBeenCalledWith('pty-A', 'test\r');
  expect(useTerminalStore.getState().activeKey).toBe(a);
});
