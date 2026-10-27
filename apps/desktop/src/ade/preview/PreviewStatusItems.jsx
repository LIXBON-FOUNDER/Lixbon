// PreviewStatusItems.jsx — lo que la vista previa pone en la barra de estado, como en la maqueta:
// la cuota de cada agente junto a la rama y los hosts junto a la conexión.
import { useWorkbenchStore } from '../../store/workbenchStore';
import { providerName } from '../../orch/agent/agentIdentity';
import { usePreviewSource } from './previewSource';
import { usePreviewStore, hostCount } from './previewStore';
import { USAGE, CURRENT_HOST } from './previewData';
import { hostOf } from './previewVocab';
import { I, Meter } from './PreviewUi';

/** La barra de estado muestra la vista previa solo cuando se ve el ADE de Orquestar con esa fuente. */
export function usePreviewStatusActive() {
  const mode = useWorkbenchStore((s) => s.mode);
  const orchView = useWorkbenchStore((s) => s.orchView);
  const source = usePreviewSource((s) => s.source);
  return mode === 'orch' && orchView === 'ade' && source === 'preview';
}

export function PreviewStatusUsage() {
  const setView = usePreviewStore((s) => s.setView);
  return USAGE.slice(0, 2).map((u) => (
    <button key={u.provider} type="button" className="statusbar__item pv-status__use" onClick={() => setView('usage')} title={`${providerName(u.provider)} · ${u.pct}% de la ${u.windowLabel} · se reinicia en ${u.reset}`}>
      <span>{providerName(u.provider)}</span>
      <Meter pct={u.pct} />
      <span className="mono">{u.pct}%</span>
    </button>
  ));
}

export function PreviewStatusHosts() {
  const s = usePreviewStore();
  const online = s.hosts.filter((h) => h.status !== 'offline').length;
  const detail = s.hosts.map((h) => `${h.name}: ${h.status === 'offline' ? 'desconectado' : `${hostCount(s, h.id)} Intentos`}`).join('\n');
  return (
    <button type="button" className="statusbar__item pv-status__hosts" onClick={() => s.setView('hosts')} title={`Hosts · ${online} de ${s.hosts.length} conectados\n${detail}`}>
      <I n="server" size={13} />
      Hosts
    </button>
  );
}

export const previewHostName = () => hostOf(CURRENT_HOST).name;
