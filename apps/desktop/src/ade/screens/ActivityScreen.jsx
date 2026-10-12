// ActivityScreen.jsx — actividad global (eventos durables), filtrable por proyecto.
// Hoy es simulada; la forma de cada entrada ya es el sobre de eventos del slice E.
import { useState } from 'react';
import { useAdeQuery } from '../state/useAdeQuery';
import { useNow } from '../state/useNow';
import { ScreenFrame } from './detail/ScreenFrame';
import { ActivityLine } from '../components/rows';
import { EmptyState, QueryBoundary } from '../components/states';
import { routes } from '../navigation/routes';

export function ActivityScreen() {
  const now = useNow();
  const [projectId, setProjectId] = useState('');
  const proyectosQ = useAdeQuery((c) => c.listProjects({ includeArchived: true }), []);
  const q = useAdeQuery((c) => c.listActivity({ projectId: projectId || undefined, limit: 100 }), [projectId]);
  const nombres = Object.fromEntries((proyectosQ.data || []).map((p) => [p.id, p.name]));
  return (
    <ScreenFrame
      route={routes.activity()} entities={{}} title="Actividad" subtitle="Qué ha ocurrido, quién lo hizo y desde qué cliente."
      actions={(
        <label className="ade-field ade-field--inline">
          <span className="ade-sr">Filtrar por proyecto</span>
          <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Filtrar por proyecto">
            <option value="">Todos los proyectos</option>
            {(proyectosQ.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
    >
      <QueryBoundary query={q} errorTitle="No se pudo cargar la actividad" empty={<EmptyState title="Sin actividad">No hay eventos para este filtro.</EmptyState>}>
        {(entradas) => <ul className="ade-activitylist">{entradas.map((e) => <ActivityLine key={e.id} entry={e} now={now} projectName={projectId ? null : nombres[e.projectId]} />)}</ul>}
      </QueryBoundary>
    </ScreenFrame>
  );
}
