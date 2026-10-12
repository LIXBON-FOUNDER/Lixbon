// ProjectCard.jsx — resumen de un proyecto: nombre, ubicación, contadores por grupo visual y sus Tasks.
// Sobrevive al cambio de fuente de datos: solo recibe Project, Tasks, Attempts y el resumen ya calculado.
import { ProjectHeader, GroupCounters, TaskRow } from './rows';
import { NavLink } from './NavLink';
import { attemptsByTaskId } from '../domain-view/projects';
import { routes } from '../navigation/routes';

/** @param {{project: object, summary: object, tasks: object[], attempts: object[], now: number, maxTasks?: number}} props */
export function ProjectCard({ project, summary, tasks, attempts, now, maxTasks = 4 }) {
  const porTarea = attemptsByTaskId(attempts);
  const abiertas = tasks.filter((t) => !['integrated', 'discarded'].includes(t.derivedState));
  const visibles = abiertas.slice(0, maxTasks);
  return (
    <article className="ade-projcard" data-testid={`project-${project.id}`} aria-label={`Proyecto ${project.name}`}>
      <header className="ade-projcard__head">
        <ProjectHeader project={project} summary={summary} />
        <div className="ade-projcard__side">
          {summary.attentionCount > 0 && <span className="ade-badge-attn" title="Elementos que esperan tu decisión">{summary.attentionCount} {summary.attentionCount === 1 ? 'pendiente' : 'pendientes'}</span>}
        </div>
      </header>
      <div className="ade-projcard__counters"><GroupCounters byGroup={summary.byGroup} /></div>
      {visibles.length === 0 ? (
        <p className="ade-muted ade-projcard__none">{tasks.length ? 'Todo integrado o descartado.' : 'Sin tareas todavía.'}</p>
      ) : (
        <div className="ade-projcard__tasks">
          {visibles.map((t) => <TaskRow key={t.id} task={t} attempts={porTarea[t.id] || []} now={now} />)}
        </div>
      )}
      {abiertas.length > maxTasks && <NavLink route={routes.project(project.id)} className="ade-projcard__more">Ver las {abiertas.length} tareas abiertas</NavLink>}
    </article>
  );
}
