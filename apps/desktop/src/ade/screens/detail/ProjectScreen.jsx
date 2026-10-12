// ProjectScreen.jsx — un proyecto: su atención, sus Tasks por estado derivado y su actividad.
import { useMemo, useState } from 'react';
import { useNow } from '../../state/useNow';
import { useProjectDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { TaskRow, ProjectHeader, GroupCounters, ActivityLine } from '../../components/rows';
import { AttentionCard } from '../../components/AttentionCard';
import { ActionButton } from '../../components/ActionButton';
import { LaunchPanel } from '../../components/LaunchPanel';
import { EmptyState } from '../../components/states';
import { buildAttentionViews } from '../../domain-view/attention';
import { attemptsByTaskId, summarizeProject } from '../../domain-view/projects';
import { routes } from '../../navigation/routes';
import { TASK_DERIVED_LABELS } from '../../vocab/vocabulario';

// Orden de lectura: lo que está en juego primero, lo cerrado al final.
const ORDEN = ['in_progress', 'in_review', 'open', 'integrated', 'discarded'];

export function ProjectScreen({ projectId }) {
  const q = useProjectDetail(projectId);
  const now = useNow();
  const route = routes.project(projectId);
  return (
    <DetailBoundary route={route} query={q}>
      {(d) => <ProjectBody route={route} d={d} now={now} />}
    </DetailBoundary>
  );
}

function ProjectBody({ route, d, now }) {
  const { project, tasks, attempts, attention, activity } = d;
  const [lanzando, setLanzando] = useState(false);
  const porTarea = useMemo(() => attemptsByTaskId(attempts), [attempts]);
  const resumen = useMemo(() => summarizeProject(project, { tasks, attempts, attention, activity }), [project, tasks, attempts, attention, activity]);
  const vistas = useMemo(() => buildAttentionViews(attention, { projects: [project], tasks, attempts }), [attention, project, tasks, attempts]);
  const grupos = ORDEN.map((estado) => ({ estado, tasks: tasks.filter((t) => t.derivedState === estado) })).filter((g) => g.tasks.length);

  return (
    <ScreenFrame
      route={route} entities={{ project }} title={project.name}
      subtitle={<><ProjectHeader project={project} summary={resumen} /><GroupCounters byGroup={resumen.byGroup} /></>}
      actions={<ActionButton intent="launch_task" label={lanzando ? 'Cancelar' : 'Lanzar trabajo nuevo'} onClick={() => setLanzando((v) => !v)} />}
    >
      {lanzando && <LaunchPanel projectId={project.id} onDone={() => setLanzando(false)} onCancel={() => setLanzando(false)} />}
      {vistas.length > 0 && (
        <Section title="Requiere tu atención" count={vistas.length} id="p-attn">
          <div className="ade-inbox__cards">{vistas.map((v) => <AttentionCard key={v.item.id} view={v} now={now} compact />)}</div>
        </Section>
      )}
      <Section title="Tareas" count={tasks.length} id="p-tasks">
        {tasks.length === 0 ? <EmptyState title="Este proyecto no tiene tareas">Lanza trabajo nuevo para crear la primera.</EmptyState> : grupos.map((g) => (
          <div key={g.estado} className="ade-taskgroup" data-derived={g.estado}>
            <h3 className="ade-taskgroup__title">{TASK_DERIVED_LABELS[g.estado]} <span className="ade-count">{g.tasks.length}</span></h3>
            {g.tasks.map((t) => <TaskRow key={t.id} task={t} attempts={porTarea[t.id] || []} now={now} />)}
          </div>
        ))}
      </Section>
      <Section title="Actividad del proyecto" id="p-act">
        {activity.length === 0 ? <EmptyState title="Sin actividad" compact /> : <ul className="ade-activitylist">{activity.slice(0, 8).map((e) => <ActivityLine key={e.id} entry={e} now={now} />)}</ul>}
      </Section>
    </ScreenFrame>
  );
}
