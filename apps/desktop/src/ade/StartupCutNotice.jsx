import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { COPY, startupCutCopy } from './adeLabels';
import { PathText } from './PathText';

const SEEN_KEY = 'lixbon.ade.startupCutSeen';

/** Lee una vez lo que hizo el corte en este arranque (`orch_startup_cut`). Nunca lanza. */
export async function loadStartupCut() {
  try {
    const value = await invoke('orch_startup_cut');
    return value && typeof value === 'object' && typeof value.status === 'string' ? value : null;
  } catch {
    return null;
  }
}

function seenBackup() {
  try { return globalThis.localStorage?.getItem(SEEN_KEY) ?? null; } catch { return null; }
}
function markSeen(backup) {
  try { globalThis.localStorage?.setItem(SEEN_KEY, backup); } catch { /* sin almacenamiento: se oculta solo en esta sesión */ }
}

function Detail({ message }) {
  return (
    <details>
      <summary>{COPY.technicalDetail}</summary>
      <code>{message}</code>
    </details>
  );
}

/**
 * LXO-123 · Aviso de arranque del corte Task/Attempt.
 * - `storage.status === 'rejected'` (de `core_model`, p. ej. `core_cut_legacy_numbering`): pide restaurar la copia.
 * - Corte aplicado ahora: aviso único con la ruta de la copia `pre-f3-cut`.
 * - Corte fallido / sin almacén: dice que los datos quedaron sin cambios. El mensaje completo va a «Detalle técnico».
 */
export function StartupCutNotice({ storage = null, load = loadStartupCut }) {
  const [cut, setCut] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve(load()).then((value) => { if (alive) setCut(value ?? null); }, () => {});
    return () => { alive = false; };
  }, [load]);

  if (storage?.status === 'rejected') {
    const copy = startupCutCopy(storage.code);
    return (
      <div className={`ade-notice ade-notice--${copy.tone} ade-startup-cut`} role="alert" data-code={storage.code ?? ''}>
        <span>{copy.text}</span>
        <Detail message={storage.message ?? storage.code ?? ''} />
      </div>
    );
  }
  if (!cut || dismissed) return null;
  if (cut.status === 'applied' && typeof cut.backup === 'string' && cut.backup) {
    if (seenBackup() === cut.backup) return null;
    const close = () => { markSeen(cut.backup); setDismissed(true); };
    return (
      <div className="ade-notice ade-notice--info ade-startup-cut" role="status" data-code="core_cut_applied">
        <span>{COPY.cutApplied}</span> <PathText path={cut.backup} />
        <button type="button" className="lk" onClick={close}>{COPY.cutDismiss}</button>
      </div>
    );
  }
  if (cut.status === 'failed') {
    const copy = startupCutCopy(cut.code);
    return (
      <div className={`ade-notice ade-notice--${copy.tone} ade-startup-cut`} role="alert" data-code={cut.code ?? ''}>
        <span>{copy.text}</span>
        <button type="button" className="lk" onClick={() => setDismissed(true)}>{COPY.cutDismiss}</button>
        <Detail message={cut.message ?? ''} />
      </div>
    );
  }
  return null;
}
