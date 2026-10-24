import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StartupCutNotice, loadStartupCut } from './StartupCutNotice';
import { COPY } from './adeLabels';
import { invoke } from '@tauri-apps/api/core';
import { coreModelFromState } from './useCoreModel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const BACKUP = 'C:/Users/u/AppData/Roaming/lixbon/core/backups/pre-f3-cut-20261023.db';
const mount = (cut, storage = null) => render(<StartupCutNotice storage={storage} load={() => Promise.resolve(cut)} />);

describe('StartupCutNotice (LXO-234)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('corte aplicado: aviso único con la ruta de la copia como PathText; al cerrarlo no vuelve', async () => {
    mount({ status: 'applied', backup: BACKUP, code: null, message: null });
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain(COPY.cutApplied);
    expect(notice.querySelector('code.mono').getAttribute('title')).toBe(BACKUP);
    expect(notice.querySelector('a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.cutDismiss }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    mount({ status: 'applied', backup: BACKUP, code: null, message: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.ade-startup-cut')).toBeNull();
  });

  it('ya cortado o sin ejecutar: no muestra nada', async () => {
    for (const status of ['already_cut', 'not_run']) {
      mount({ status, backup: null, code: null, message: null });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.querySelector('.ade-startup-cut')).toBeNull();
      cleanup();
    }
  });

  it('core_cut_legacy_numbering desde core_model.storage: pide restaurar pre-f3-cut y deja el mensaje en «Detalle técnico»', async () => {
    const raw = 'core_cut_legacy_numbering: la base se cortó como última + 1; restaura pre-f3-cut';
    const model = coreModelFromState({ data: { core_model: 'legacy', compat: [], queries: [], storage: { status: 'rejected', code: 'core_cut_legacy_numbering', message: raw } }, error: null });
    mount(null, model.storage);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(COPY.cutLegacyNumbering);
    expect(alert.querySelector('summary').textContent).toBe(COPY.technicalDetail);
    expect(alert.querySelector('details code').textContent).toBe(raw);
  });

  it('core_cut_failed: dice que los datos quedaron sin cambios', async () => {
    mount({ status: 'failed', backup: null, code: 'core_cut_failed', message: 'core_cut_failed: preflight' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(COPY.cutFailed);
    expect(alert.querySelector('details code').textContent).toBe('core_cut_failed: preflight');
  });

  it('model_unavailable: tiene su propio texto', async () => {
    mount({ status: 'failed', backup: null, code: 'model_unavailable', message: 'model_unavailable: el almacén no está abierto' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(COPY.cutModelUnavailable);
    expect(alert.textContent).not.toContain(COPY.cutFailed);
  });

  it('loadStartupCut lee orch_startup_cut y nunca lanza', async () => {
    invoke.mockResolvedValueOnce({ status: 'applied', backup: BACKUP });
    await expect(loadStartupCut()).resolves.toMatchObject({ status: 'applied' });
    expect(invoke).toHaveBeenCalledWith('orch_startup_cut');
    invoke.mockRejectedValueOnce(new Error('Comando desconocido: orch_startup_cut'));
    await expect(loadStartupCut()).resolves.toBeNull();
    invoke.mockResolvedValueOnce(undefined);
    await expect(loadStartupCut()).resolves.toBeNull();
  });
});
