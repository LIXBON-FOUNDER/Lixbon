import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { PreviewShell } from './PreviewShell';
import { usePreviewStore } from './previewStore';
import { usePreviewSource } from './previewSource';
import { useWorkbenchStore } from '../../store/workbenchStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const mount = () => render(<PreviewShell leftOpen rightOpen active />);
const tab = (name) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  usePreviewStore.getState().resetAll();
  useWorkbenchStore.setState((s) => ({ mode: 'orch', orchView: 'ade', modePanels: { ...s.modePanels, orch: { left: true, right: true, adeRight: true } } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Vista previa del ADE', () => {
  it('se declara simulada y abre el Workspace del Intento elegido', () => {
    mount();
    expect(screen.getByText('Vista previa · datos simulados')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Runtime de agentes' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Ciclo de vida del Intento' })).toBeTruthy();
    expect(tab('Workspace').getAttribute('aria-selected')).toBe('true');
  });

  it('cuenta Attention en un solo sitio del navegador y lo abre', () => {
    mount();
    const need = screen.getByRole('button', { name: /Esperan tu decisión/ });
    expect(within(need).getByText('9')).toBeTruthy();
    fireEvent.click(need);
    expect(tab('Attention').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Attention' })).toBeTruthy();
  });

  it('decide desde el teclado: A permite una vez el permiso elegido y pasa al siguiente', () => {
    mount();
    fireEvent.click(tab('Attention'));
    const detail = screen.getByRole('region', { name: 'Solicitud elegida' });
    expect(within(detail).getByText('Red y un binario sin verificar')).toBeTruthy();
    expect(within(detail).getByText('Justo antes, el agente')).toBeTruthy();
    fireEvent.keyDown(detail, { key: 'a' });
    expect(usePreviewStore.getState().attention.some((x) => x.id === 'at_net_ch')).toBe(false);
    expect(usePreviewStore.getState().decisions[0]).toMatchObject({ decision: 'allow_once', command: expect.stringContaining('curl') });
  });

  it('el riesgo alto no ofrece permitir en todo el Intento', () => {
    mount();
    fireEvent.click(tab('Attention'));
    const detail = screen.getByRole('region', { name: 'Solicitud elegida' });
    expect(within(detail).queryByRole('button', { name: 'Permitir en este Intento' })).toBeNull();
    expect(within(detail).getByText(/sin opción «siempre»/)).toBeTruthy();
  });

  it('con el agente ocupado, Enter deja la instrucción en la cola sin interrumpir', () => {
    mount();
    const input = screen.getByRole('textbox', { name: 'Instrucción' });
    fireEvent.change(input, { target: { value: 'Revisa también Linux' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const pending = usePreviewStore.getState().pending.att_rt_a;
    expect(pending.at(-1)).toMatchObject({ mode: 'queue', text: 'Revisa también Linux' });
    expect(usePreviewStore.getState().attempts.find((a) => a.id === 'att_rt_a').state).toBe('working');
  });

  it('reproduce el Intento hasta un evento anterior y vuelve a ahora', () => {
    mount();
    const slider = screen.getByLabelText('Reproducir');
    fireEvent.change(slider, { target: { value: '1' } });
    expect(screen.getByText(/Viendo el Intento a las/)).toBeTruthy();
    expect(screen.queryByText(/La máquina de estados y los eventos están/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ahora' }));
    expect(screen.getByText(/La máquina de estados y los eventos están/)).toBeTruthy();
  });

  it('Proof Pack: aceptar va atado a la revisión mostrada', () => {
    act(() => usePreviewStore.getState().select('att_oa_b', 'proof'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar @ a91f3c2' }));
    const a = usePreviewStore.getState().attempts.find((x) => x.id === 'att_oa_b');
    expect(a).toMatchObject({ reviewVerdict: 'accepted', integrationStatus: 'pending' });
    expect(usePreviewStore.getState().timelines.att_oa_b.at(-1).text).toMatch(/a91f3c2/);
  });

  it('Componer arranca un Intento nuevo con los archivos elegidos', () => {
    act(() => usePreviewStore.getState().select('att_oa_b', 'compare'));
    mount();
    fireEvent.click(tab('Componer'));
    const start = screen.getByRole('button', { name: /Arrancar Intento combinado/ });
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: /tomar$/ })[0]);
    fireEvent.click(start);
    const s = usePreviewStore.getState();
    const created = s.attempts.at(-1);
    expect(created).toMatchObject({ taskId: 't_oauth', label: 'C' });
    expect(s.sel.attemptId).toBe(created.id);
  });
});

describe('Fuente de Orquestar', () => {
  it('en desarrollo la vista previa está disponible y se recuerda la elección', () => {
    usePreviewSource.getState().setSource('preview');
    expect(usePreviewSource.getState().source).toBe('preview');
    expect(localStorage.getItem('lx_ade_source')).toBe('preview');
    usePreviewSource.getState().setSource('core');
    expect(localStorage.getItem('lx_ade_source')).toBe('core');
  });
});
