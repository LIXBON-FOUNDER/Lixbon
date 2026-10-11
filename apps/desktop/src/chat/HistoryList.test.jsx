import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { HistoryList } from './HistoryList';
import { useAppStore } from '../store/appStore';
import { useCodexTermStore } from '../orch/codexterm/codexTermStore';
import { codexTerm } from '../orch/codexterm/codexTermContract';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(async () => ({ conversations: [{ id: 'g1', title: 'Migrar la facturación', updated_at: new Date(Date.now() - 3000).toISOString(), archived: false }] })), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('../lib/claudeCode', () => ({
  claudeSessions: vi.fn(async () => [{ id: 'c1', title: 'Revisar el CI de Claude', updated_ms: Date.now() - 2000, archived: false }]),
  claudeDeleteSession: vi.fn(), claudeArchiveSession: vi.fn(),
}));

const CODEX_ID = '01a123cf-5f63-7591-b38c-67509d3a1ce1';
const session = { id: CODEX_ID, cwd: 'C:/repo/apps/web', title: 'Arreglar los estilos de Codex', updated_ms: now - 1000, model: 'gpt-6.1-sol' };

beforeEach(() => {
  try { localStorage.clear(); } catch { /* sin almacenamiento */ }
  useAppStore.setState({ workspaceRoot: 'C:/repo' });
  useCodexTermStore.setState({ tabs: [], activeKey: null, launcher: false, launcherResume: null, buffers: {} });
  vi.spyOn(codexTerm, 'sessions').mockResolvedValue([session]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rows = () => Array.from(document.querySelectorAll('.hist__title')).map((e) => e.textContent);
const waitForAll = () => waitFor(() => expect(rows().sort()).toEqual(['Arreglar los estilos de Codex', 'Migrar la facturación', 'Revisar el CI de Claude']));

describe('historial único', () => {
  it('junta las conversaciones de Lixbon, Claude Code y Codex, con su marca cada una', async () => {
    render(<HistoryList />);
    await waitForAll();
    expect(screen.getByTestId('hist-filter-all').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('hist-filter-codex').textContent).toContain('1');
    const marks = Array.from(document.querySelectorAll('.hist__mark')).map((e) => e.getAttribute('title')).sort();
    expect(marks).toEqual(['Claude Code', 'Codex', 'Lixbon']);
  });

  it('el filtro deja un solo agente y se recuerda', async () => {
    const { unmount } = render(<HistoryList />);
    await waitForAll();
    fireEvent.click(screen.getByTestId('hist-filter-codex'));
    expect(rows()).toEqual(['Arreglar los estilos de Codex']);
    fireEvent.click(screen.getByTestId('hist-filter-claude'));
    expect(rows()).toEqual(['Revisar el CI de Claude']);
    unmount();

    render(<HistoryList />);
    expect(screen.getByTestId('hist-filter-claude').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(rows()).toEqual(['Revisar el CI de Claude']));
  });

  it('abrir una sesión de Codex abre el panel para reanudarla en su carpeta', async () => {
    render(<HistoryList />);
    await waitForAll();
    fireEvent.click(screen.getByText('Arreglar los estilos de Codex'));
    const st = useCodexTermStore.getState();
    expect(st.launcher).toBe(true);
    expect(st.launcherResume).toEqual({ id: CODEX_ID, title: 'Arreglar los estilos de Codex', cwd: 'C:/repo/apps/web', model: 'gpt-6.1-sol' });
  });

  it('las sesiones de Codex no ofrecen renombrar, archivar ni borrar (son de Codex)', async () => {
    render(<HistoryList />);
    await waitForAll();
    const codexRow = screen.getByText('Arreglar los estilos de Codex').closest('.hist__item');
    expect(within(codexRow).queryByTitle('Eliminar')).toBeNull();
    expect(within(codexRow).queryByTitle(/Archivar/)).toBeNull();
    const claudeRow = screen.getByText('Revisar el CI de Claude').closest('.hist__item');
    expect(within(claudeRow).getByTitle('Eliminar')).toBeTruthy();
  });

  it('la búsqueda también filtra las sesiones locales de Claude y Codex', async () => {
    render(<HistoryList />);
    await waitForAll();
    fireEvent.click(screen.getByText('Buscar'));
    fireEvent.change(screen.getByPlaceholderText('Buscar conversaciones'), { target: { value: 'estilos' } });
    await waitFor(() => expect(rows()).not.toContain('Revisar el CI de Claude'));
    expect(rows()).toContain('Arreglar los estilos de Codex');
  });

  it('sin carpeta abierta no pide sesiones de Codex', async () => {
    useAppStore.setState({ workspaceRoot: '' });
    render(<HistoryList />);
    await waitFor(() => expect(rows()).toEqual(['Migrar la facturación']));
    expect(codexTerm.sessions).not.toHaveBeenCalled();
  });
});
