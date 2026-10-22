import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from './builtin';
import { DEFAULT_KEYMAP } from '../lib/keymap';
import { runCommand } from '../lib/commands';
import { selectSidePanels, useWorkbenchStore } from '../store/workbenchStore';

const initialPanels = {
  agent: { left: true, right: true },
  design: { left: true, right: true },
  git: { left: true, right: true },
  orch: { left: true, right: true, adeRight: true },
};

beforeAll(() => registerBuiltinCommands());

beforeEach(() => {
  localStorage.clear();
  useWorkbenchStore.setState({
    mode: 'editor',
    orchView: 'executions',
    adeDrawer: false,
    drawer: false,
    sideOpen: true,
    sideView: 'files',
    agentOpen: true,
    modePanels: structuredClone(initialPanels),
  });
});

describe('atajos de panel en el Orquestador', () => {
  it('conserva los bindings globales Ctrl+B y Ctrl+Alt+B', async () => {
    expect(DEFAULT_KEYMAP['ctrl+b']).toBe('workbench.toggleExplorer');
    expect(DEFAULT_KEYMAP['ctrl+alt+b']).toBe('workbench.toggleAgent');
  });

  it.each([
    ['Ejecuciones', 'executions'],
    ['ADE', 'ade'],
  ])('Ctrl+B alterna la navegación unificada desde el contexto %s', async (_label, view) => {
    useWorkbenchStore.setState({ mode: 'orch', orchView: view });

    await runCommand(DEFAULT_KEYMAP['ctrl+b']);

    const state = useWorkbenchStore.getState();
    expect(state.mode).toBe('orch');
    expect(state.modePanels.orch.left).toBe(false);
    useWorkbenchStore.getState().setOrchView(view === 'ade' ? 'executions' : 'ade');
    expect(selectSidePanels(useWorkbenchStore.getState()).left).toBe(false);
    expect(state.sideOpen).toBe(true);
  });

  it.each([
    ['Ejecuciones', 'executions', 'right'],
    ['ADE', 'ade', 'adeRight'],
  ])('Ctrl+Alt+B alterna el panel derecho de %s sin salir del Orquestador', async (_label, view, panel) => {
    useWorkbenchStore.setState({ mode: 'orch', orchView: view });

    await runCommand(DEFAULT_KEYMAP['ctrl+alt+b']);

    const state = useWorkbenchStore.getState();
    expect(state.mode).toBe('orch');
    expect(state.modePanels.orch[panel]).toBe(false);
    expect(state.drawer).toBe(false);
    expect(state.adeDrawer).toBe(false);
  });

  it('mantiene la ruta existente del Editor y los demás modos', async () => {
    await runCommand(DEFAULT_KEYMAP['ctrl+b']);
    expect(useWorkbenchStore.getState().sideOpen).toBe(false);

    useWorkbenchStore.setState({ mode: 'git' });
    await runCommand(DEFAULT_KEYMAP['ctrl+b']);
    expect(useWorkbenchStore.getState().mode).toBe('editor');
    expect(useWorkbenchStore.getState().sideView).toBe('files');
    expect(useWorkbenchStore.getState().sideOpen).toBe(true);

    useWorkbenchStore.setState({ mode: 'git' });
    await runCommand(DEFAULT_KEYMAP['ctrl+alt+b']);
    expect(useWorkbenchStore.getState().mode).toBe('editor');
    expect(useWorkbenchStore.getState().agentOpen).toBe(false);
  });
});
