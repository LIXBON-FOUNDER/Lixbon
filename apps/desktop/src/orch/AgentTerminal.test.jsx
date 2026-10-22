import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  terminals: [],
  invoke: vi.fn(),
  listen: vi.fn(),
  observers: [],
  fit: { proposeDimensions: vi.fn(() => ({ cols: 120, rows: 30 })) },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() { this.cols = 80; this.rows = 24; this.unicode = {}; mocks.terminals.push(this); }
    loadAddon() {}
    open() {}
    write() {}
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    onData() {}
    dispose() {}
    options = {};
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return mocks.fit.proposeDimensions(); } } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../editor/TerminalPanel', () => ({ FONT: 'Arial' }));
vi.mock('../editor/xtermThemes', () => ({ currentXtermTheme: () => ({}) }));
vi.mock('../editor/themeMode', () => ({ watchTheme: () => () => {} }));
vi.mock('../lib/orchTermSize', () => ({ computePtySize: (cols, rows) => ({ cols: Math.max(200, cols), rows }), ptyCols: { set: vi.fn() } }));

import { AgentTerminal } from './AgentTerminal';

let originalResizeObserver;
let originalFonts;

beforeEach(() => {
  mocks.terminals.length = 0;
  mocks.observers.length = 0;
  mocks.invoke.mockReset().mockResolvedValue('buffer');
  mocks.listen.mockReset().mockResolvedValue(() => {});
  originalResizeObserver = globalThis.ResizeObserver;
  originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn().mockResolvedValue([]) } });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; mocks.observers.push(this); }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else delete globalThis.ResizeObserver;
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else delete document.fonts;
});

describe('AgentTerminal visibility', () => {
  it('retains the PTY size while hidden and resizes when the execution canvas returns', async () => {
    const view = render(<AgentTerminal task="t1" live visible />);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orch_term_resize')).toHaveLength(1));
    const terminal = mocks.terminals[0];
    const originalRows = terminal.rows;
    const originalCols = terminal.cols;

    view.rerender(<AgentTerminal task="t1" live visible={false} />);
    mocks.observers[0].callback();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orch_term_resize')).toHaveLength(1);
    expect(terminal.cols).toBe(originalCols);
    expect(terminal.rows).toBe(originalRows);

    view.rerender(<AgentTerminal task="t1" live visible />);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orch_term_resize')).toHaveLength(2));
    expect(mocks.terminals).toHaveLength(1);
  });
});
