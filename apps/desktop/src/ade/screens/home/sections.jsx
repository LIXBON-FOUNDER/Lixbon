// sections.jsx — las tres secciones del Inicio: bandeja de Attention, Proyectos y Actividad.
//
// Cada sección recibe una CONSULTA (estado cargando/listo/error) y se pinta sola: si Attention falla pero
// los proyectos cargan, se ve el resto. Ninguna sabe de dónde vienen los datos (mock hoy, Core mañana).
import { useMemo } from 'react';
import { AttentionCard } from '../../components/AttentionCard';
import { ProjectCard } from '../../components/ProjectCard';
import { ActivityLine } from '../../components/rows';
import { Section } from '../../components/small';
import { EmptyState, QueryBoundary } from '../../components/states';
import { NavLink } from '../../components/NavLink';
import { ActionButton } from '../../components/ActionButton';
import { buildAttentionViews, groupAttentionByKind, visibleAttention } from '../../domain-view/attention';
import { sortProjectsByHeat, summarizeProject } from '../../domain-view/projects';
import { routes } from '../../navigation/routes';
import { ATTENTION_TITLES } from '../../vocab/vocabulario';

const lista = (q) => (Array.isArray(q?.data) ? q.data : []);

export function AttentionInbox({ attentionQ, projectsQ, tasksQ, attemptsQ, now, compact = false }) {
  const joins = { projects: lista(projectsQ), tasks: lista(tasksQ), attempts: lista(attemptsQ) };
  return (
    <QueryBoundary
      query={attentionQ} loadingLabel="Cargando atención…" errorTitle="No se pudo cargar la atención"
      empty={(
        <Section title="Requiere tu atención" count={0} id="attn">
          <EmptyState title="Nada necesita tu atención" compact={compact}>
            Cuando un agente pregunte, falle, pida aprobación o termine algo que revisar, aparecerá aquí.
          </EmptyState>
        </Section>
      )}
    >
      {(items) => <InboxList items={items} joins={joins} now={now} compact={compact} />}
    </QueryBoundary>
  );
}

function InboxList({ items, joins, now, compact }) {
  const visibles = useMemo(() => visibleAttention(items, now), [items, now]);
  const grupos = useMemo(() => groupAttentionByKind(visibles), [visibles]);
  const vistas = useMemo(() => new Map(buildAttentionViews(visibles, joins).map((v) => [v.item.id, v])), [visibles, joins]);
  if (!visibles.length) {
    return (
      <Section title="Requiere tu atención" count={0} id="attn">
        <EmptyState title="Nada necesita tu atención" compact={compact}>Todo lo pospuesto volverá cuando venza el aplazamiento.</EmptyState>
      </Section>
    );
  }
  return (
    <Section title="Requiere tu atención" count={visibles.length} id="attn" className="ade-inbox">
      {grupos.map((g) => (
        <div key={g.kind} className="ade-inbox__group" data-kind={g.kind}>
          <h3 className="ade-inbox__kind">{ATTENTION_TITLES[g.kind] || g.kind} <span className="ade-count">{g.items.length}</span></h3>
          <div className="ade-inbox__cards">
            {g.items.map((i) => <AttentionCard key={i.id} view={vistas.get(i.id)} now={now} compact={compact} />)}
          </div>
        </div>
      ))}
    </Section>
  );
}

export function ProjectsOverview({ projectsQ, tasksQ, attemptsQ, attentionQ, activityQ, now, onlyOpen = false }) {
  const proyectos = lista(projectsQ);
  const tasks = lista(tasksQ);
  const attempts = lista(attemptsQ);
  const attention = lista(attentionQ);
  const activity = lista(activityQ);
  const resumenes = useMemo(
    () => Object.fromEntries(proyectos.map((p) => [p.id, summarizeProject(p, { tasks, attempts, attention, activity })])),
    [proyectos, tasks, attempts, attention, activity],
  );
  const ordenados = useMemo(() => sortProjectsByHeat(proyectos, resumenes), [proyectos, resumenes]);

  // Las tres consultas que dibujan las tarjetas deben estar listas; si una falla, el error se ve en su sección.
  const principal = projectsQ.status === 'error' || projectsQ.data === null ? projectsQ : tasksQ.data === null ? tasksQ : attemptsQ.data === null ? attemptsQ : projectsQ;

  return (
    <Section title="Proyectos" count={proyectos.length || undefined} id="proj" aside={<NavLink route={routes.projects()}>Ver todos</NavLink>}>
      <QueryBoundary
        query={principal} loadingLabel="Cargando proyectos…" errorTitle="No se pudieron cargar los proyectos" rows={4}
        empty={(
          <EmptyState title="Todavía no hay proyectos">
            Cuando registres un proyecto, aquí verás sus tareas, agentes y estado.
            <div className="ade-empty__cta"><ActionButton intent="register_project" args={{ path: '' }} /></div>
          </EmptyState>
        )}
      >
        {() => (
          <div className="ade-projlist">
            {ordenados.filter((p) => !onlyOpen || p.state === 'active').map((p) => (
              <ProjectCard
                key={p.id} project={p} summary={resumenes[p.id]} now={now}
                tasks={tasks.filter((t) => t.projectId === p.id)} attempts={attempts.filter((a) => a.projectId === p.id)}
              />
            ))}
          </div>
        )}
      </QueryBoundary>
    </Section>
  );
}

export function ActivityStrip({ activityQ, projectsQ, now, limit = 10, title = 'Actividad reciente' }) {
  const nombres = useMemo(() => Object.fromEntries(lista(projectsQ).map((p) => [p.id, p.name])), [projectsQ]);
  return (
    <Section title={title} id="act" aside={<NavLink route={routes.activity()}>Ver todo</NavLink>}>
      <QueryBoundary
        query={activityQ} loadingLabel="Cargando actividad…" errorTitle="No se pudo cargar la actividad"
        empty={<EmptyState title="Sin actividad todavía" compact>Los eventos de los agentes y tus decisiones aparecerán aquí.</EmptyState>}
      >
        {(entradas) => (
          <ul className="ade-activitylist">
            {entradas.slice(0, limit).map((e) => <ActivityLine key={e.id} entry={e} now={now} projectName={nombres[e.projectId]} />)}
          </ul>
        )}
      </QueryBoundary>
    </Section>
  );
}
