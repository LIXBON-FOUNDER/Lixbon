import { afterEach, expect, it, vi } from 'vitest';
import { queryAdeCore } from './coreQueries';
import { openAttemptWorkspace, useIdeAttempt } from './f6Navigation';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useTerminalStore } from '../store/terminalStore';
vi.mock('./coreQueries', () => ({ queryAdeCore: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); queryAdeCore.mockReset(); useIdeAttempt.setState({ scope: null }); useTerminalStore.setState({ sessions: [], activeKey: null }); });

it('preserves unsaved files and browser choices per Attempt without inheriting another preview URL', async () => {
  const scope = (id) => ({ attempt_id: id, project_id: 'p1', task_id: id.split('-a')[0], worktree_id: `wt-${id}`, root: `/${id}`, file: null, revision: 'abcdef1234' });
  queryAdeCore.mockImplementation(async (_, args) => scope(args.attempt_id));
  useAppStore.setState({ workspaceRoot: '/t1-a1' });
  useIdeAttempt.setState({ scope: scope('t1-a1') });
  useFileViewStore.setState({ tabs: [{ path: '/t1-a1/a.rs', content: 'unsaved', saved: 'old' }], activePath: '/t1-a1/a.rs' });
  useWorkbenchStore.getState().setDesign({ url: 'http://localhost:3001' });
  vi.spyOn(useAppStore.getState(), 'openWorkspace').mockImplementation(async (root) => useAppStore.setState({ workspaceRoot: root }));
  await openAttemptWorkspace('t2-a1');
  expect(useWorkbenchStore.getState().design.url).toBe('');
  expect(useFileViewStore.getState().activePath).toBe(null);
  useWorkbenchStore.getState().setDesign({ url: 'http://localhost:3002' });
  await openAttemptWorkspace('t1-a1');
  expect(useWorkbenchStore.getState().design.url).toBe('http://localhost:3001');
  expect(useFileViewStore.getState().activePath).toBe('/t1-a1/a.rs');
  expect(useFileViewStore.getState().tabs[0].content).toBe('unsaved');
  expect(useTerminalStore.getState().sessions.find((t) => t.key === useTerminalStore.getState().activeKey).cwd).toBe('/t1-a1');
});

it('refuses a moved revision before changing root, browser, terminal or mode', async () => {
  queryAdeCore.mockResolvedValue({ attempt_id: 't3-a1', root: '/t3-a1', revision: 'bbbbbbb' });
  const open = vi.spyOn(useAppStore.getState(), 'openWorkspace');
  const before = useWorkbenchStore.getState().mode;
  await expect(openAttemptWorkspace('t3-a1', { revision: 'aaaaaaa' })).rejects.toThrow('link_stale');
  expect(open).not.toHaveBeenCalled(); expect(useWorkbenchStore.getState().mode).toBe(before);
  expect(useTerminalStore.getState().sessions).toHaveLength(0);
});
