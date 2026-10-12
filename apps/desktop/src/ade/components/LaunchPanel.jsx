// LaunchPanel.jsx — formulario para lanzar trabajo nuevo (intent launch_task).
// Hoy el host deduce el repo del cwd; un proyecto explícito llega con el slice D. En el mock crea una
// Task con un intento «pendiente de aprobación», que aparece en la bandeja como lanzamiento pendiente.
import { useState } from 'react';
import { ActionButton } from './ActionButton';
import { QueryBoundary } from './states';
import { useAdeQuery } from '../state/useAdeQuery';

export function LaunchPanel({ projectId: fijo, onDone, onCancel }) {
  const proyectosQ = useAdeQuery((c) => c.listProjects(), []);
  const agentesQ = useAdeQuery((c) => c.listAgents(), []);
  const [projectId, setProjectId] = useState(fijo || '');
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState('claude');

  return (
    <section className="ade-launch" id="ade-launch" aria-label="Lanzar trabajo nuevo">
      <QueryBoundary query={agentesQ} rows={2} isEmpty={(d) => !d.some((g) => g.available)} empty={<p className="ade-muted">No hay ningún proveedor disponible.</p>}>
        {(agentes) => (
          <QueryBoundary query={proyectosQ} rows={2} isEmpty={(d) => d.length === 0} empty={<p className="ade-muted">Sin proyectos donde lanzar.</p>}>
            {(proyectos) => (
              <form className="ade-launch__form" onSubmit={(e) => e.preventDefault()}>
                <label className="ade-field">
                  <span>Proyecto</span>
                  <select className="field" value={fijo || projectId || proyectos[0].id} disabled={Boolean(fijo)} onChange={(e) => setProjectId(e.target.value)}>
                    {proyectos.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="ade-field ade-field--grow">
                  <span>Qué quieres conseguir</span>
                  <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Describe el objetivo en una frase" />
                </label>
                <label className="ade-field">
                  <span>Agente</span>
                  <select className="field" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    {agentes.filter((g) => g.available).map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </label>
                <div className="ade-launch__actions">
                  <ActionButton
                    intent="launch_task" label="Pedir lanzamiento" variant="primary" disabled={!title.trim()}
                    args={{ projectId: fijo || projectId || proyectos[0].id, title: title.trim(), agent: { provider } }}
                    onDone={(r) => { if (r.ok) { setTitle(''); onDone?.(r); } }}
                  />
                  {onCancel && <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancelar</button>}
                </div>
                <p className="ade-muted ade-launch__note">El lanzamiento queda pendiente de tu aprobación (política efectiva visible).</p>
              </form>
            )}
          </QueryBoundary>
        )}
      </QueryBoundary>
    </section>
  );
}
