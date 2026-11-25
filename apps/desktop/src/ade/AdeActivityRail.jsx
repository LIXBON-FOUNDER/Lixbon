import { StatusIcon } from '@lixbon/icons/status';
import { Icono } from '@lixbon/icons';
import { useWorkbenchStore } from '../store/workbenchStore';
export function AdeActivityRail({ view, onSelect, hostsAvailable = false, needsAttention = false, onIntegrations }) {
  const setMode = useWorkbenchStore((s) => s.setMode);
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  return <nav className="rail" aria-label="Barra de actividad ADE">
    <button className={`rail__btn ${view === 'workspace' ? 'is-active' : ''}`} aria-label="Trabajo" title="Trabajo" onClick={() => onSelect('workspace')}><StatusIcon kind="branch" size={20} />{needsAttention && <span className="rail__badge" />}</button>
    <button className="rail__btn" aria-label="Archivos" title="Archivos" onClick={() => setMode('editor')}><Icono nombre="carpeta" size={20} /></button>
    <button className={`rail__btn ${view === 'review' ? 'is-active' : ''}`} aria-label="Cambios" title="Cambios" onClick={() => hostsAvailable ? onSelect('review') : setMode('git')}><StatusIcon kind="review" size={20} /></button>
    <button className={`rail__btn ${view === 'hosts' ? 'is-active' : ''}`} aria-label="Hosts" title={hostsAvailable ? 'Hosts' : 'Hosts · el Core aún no publica esta vista'} disabled={!hostsAvailable} onClick={() => onSelect('hosts')}><StatusIcon kind="server" size={20} /></button>
    <button className={`rail__btn ${view === 'integrations' ? 'is-active' : ''}`} aria-label="Integraciones" title="Integraciones" onClick={() => onIntegrations ? onIntegrations() : openSettings('mcp')}><Icono nombre="nodos" size={20} /></button>
  </nav>;
}
