// rows.jsx — filas reutilizables: Task, Attempt, actividad y proyecto.
import { NavLink } from './NavLink';
import { StatusMark, StatusPill } from './StatusMark';
import { AgentLabel } from './AgentLabel';
import { SimBadge } from './small';
import { latestAttempt } from '../domain-view/projects';
import { attemptDuration, formatAgo } from '../domain-view/format';
import { describeEvent, actorLabel } from '../domain-view/activity';
import { routes, routeForEntity } from '../navigation/routes';
import { TASK_DERIVED_LABELS, VISUAL_GROUPS, isFinalState } from '../vocab/vocabulario';

const GRUPO_ETIQUETA = {
  active: 'en marcha', waiting: 'esperando', needs_person: 'te necesitan', ok: 'listos', error: 'con error', halted: 'detenidos',
};

export function TaskRow({ task, attempts = [], now, showProject = null }) {
  const ult = latestAttempt(task, attempts);
  return (
    <div className="ade-row ade-taskrow" data-testid={`task-${task.id}`} data-derived={task.derivedState}>
      <span className="ade-row__lead">{ult ? <StatusMark state={ult.state} /> : <StatusMark group="halted" />}</span>
      <div className="ade-row__main">
        <NavLink route={routes.task(task.id)} className="ade-row__title">{task.title}</NavLink>
        <div className="ade-row__meta">
          {showProject && <span>{showProject}</span>}
          <span className={`ade-chip ade-chip--${task.derivedState}`}>{TASK_DERIVED_LABELS[task.derivedState] || task.derivedState}</span>
          {ult && <AgentLabel agent={ult.agent} />}
          <span>{attempts.length} {attempts.length === 1 ? 'intento' : 'intentos'}</span>
        </div>
        {ult?.note && !isFinalState(ult.state) && <div className="ade-row__note">{ult.note}</div>}
      </div>
      <time className="ade-row__time">{formatAgo(task.updatedAt, now)}</time>
    </div>
  );
}

export function AttemptLine({ attempt, now }) {
  return (
    <div className="ade-row ade-attemptline" data-testid={`attempt-${attempt.id}`} data-state={attempt.state}>
      <span className="ade-row__lead ade-ordinal mono">{attempt.ordinal}</span>
      <div className="ade-row__main">
        <NavLink route={routes.attempt(attempt.id)} className="ade-row__title">Intento {attempt.ordinal}</NavLink>
        <div className="ade-row__meta">
          <AgentLabel agent={attempt.agent} />
          <StatusPill state={attempt.state} />
          <span>{attemptDuration(attempt, now)}</span>
        </div>
        {(attempt.summary || attempt.note) && <div className="ade-row__note">{attempt.summary || attempt.note}</div>}
      </div>
    </div>
  );
}

export function ActivityLine({ entry, now, projectName }) {
  const destino = routeForEntity(entry.entity, entry);
  const texto = (
    <>
      <b>{actorLabel(entry.actor)}</b> {describeEvent(entry)}
    </>
  );
  return (
    <li className="ade-activity" data-testid={`activity-${entry.id}`} data-type={entry.type}>
      <span className={`ade-activity__dot ade-activity__dot--${entry.actor.kind}`} aria-hidden="true" />
      <div className="ade-activity__main">
        {destino ? <NavLink route={destino} className="ade-activity__text">{texto}</NavLink> : <span className="ade-activity__text">{texto}</span>}
        <span className="ade-activity__meta">{projectName ? `${projectName} · ` : ''}<span className="mono">{entry.type}</span></span>
      </div>
      <time className="ade-activity__time">{formatAgo(entry.ts, now)}</time>
    </li>
  );
}

/** Contadores por grupo visual: solo los que tienen algo. */
export function GroupCounters({ byGroup }) {
  const con = VISUAL_GROUPS.filter((g) => byGroup[g] > 0);
  if (!con.length) return <span className="ade-muted">Sin trabajo en curso</span>;
  return (
    <span className="ade-counters">
      {con.map((g) => (
        <span key={g} className={`ade-counter ade-tone-${g}`} title={GRUPO_ETIQUETA[g]} data-group={g}>
          <StatusMark group={g} size={11} /> <b>{byGroup[g]}</b> <span>{GRUPO_ETIQUETA[g]}</span>
        </span>
      ))}
    </span>
  );
}

export function ProjectHeader({ project, summary, simulated }) {
  const loc = summary?.primaryLocation;
  return (
    <div className="ade-projhead">
      <div className="ade-projhead__name">
        <span className="ade-projhead__mark" aria-hidden="true">{project.name.charAt(0).toUpperCase()}</span>
        <NavLink route={routes.project(project.id)} className="ade-projhead__title">{project.name}</NavLink>
        {project.state === 'archived' && <span className="ade-tag">archivado</span>}
        {simulated && <SimBadge />}
      </div>
      {loc && (
        <div className="ade-projhead__path mono" title={loc.path}>
          {loc.path}{loc.state === 'missing' && <span className="ade-tag ade-tag--warn" title="La ruta ya no existe en esta máquina (ProjectLocation: missing).">ruta ausente</span>}
        </div>
      )}
    </div>
  );
}
