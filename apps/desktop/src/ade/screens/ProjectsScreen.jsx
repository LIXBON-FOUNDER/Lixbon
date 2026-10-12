// ProjectsScreen.jsx — todos los proyectos de la máquina, ordenados por «calor» (atención, luego actividad).
import { useMemo } from 'react';
import { useAdeQuery } from '../state/useAdeQuery';
import { useNow } from '../state/useNow';
import { ScreenFrame } from './detail/ScreenFrame';
import { ProjectCard } from '../components/ProjectCard';
import { EmptyState, QueryBoundary } from '../components/states';
import { ActionButton } from '../components/ActionButton';
import { sortProjectsByHeat, summarizeProject } from '../domain-view/projects';
import { routes } from '../navigation/routes';

export function ProjectsScreen() {
  const now = useNow();
  const q = useAdeQuery(async (c) => {
    const [projects, tasks, attempts, attention, activity] = await Promise.all([
      c.listProjects({ includeArchived: true }), c.listTasks(), c.listAttempts(), c.listAttention(), c.listActivity({ limit: 200 }),
    ]);
    return { projects, tasks, attempts, attention, activity };
  }, []);
  return (
    <ScreenFrame route={routes.projects()} entities={{}} title="Proyectos" subtitle="Todos los proyectos de esta máquina y cuáles piden tu atención.">
      <QueryBoundary
        query={q} errorTitle="No se pudieron cargar los proyectos"
        isEmpty={(d) => d.projects.length === 0}
        empty={<EmptyState title="Todavía no hay proyectos">Registrar un proyecto es del slice D.<div className="ade-empty__cta"><ActionButton intent="register_project" args={{ path: '' }} /></div></EmptyState>}
      >
        {(d) => <ProjectsList d={d} now={now} />}
      </QueryBoundary>
    </ScreenFrame>
  );
}

function ProjectsList({ d, now }) {
  const resumenes = useMemo(() => Object.fromEntries(d.projects.map((p) => [p.id, summarizeProject(p, d)])), [d]);
  const ordenados = useMemo(() => sortProjectsByHeat(d.projects, resumenes), [d.projects, resumenes]);
  const activos = ordenados.filter((p) => p.state === 'active');
  const archivados = ordenados.filter((p) => p.state === 'archived');
  const tarjeta = (p) => (
    <ProjectCard key={p.id} project={p} summary={resumenes[p.id]} now={now} maxTasks={3}
      tasks={d.tasks.filter((t) => t.projectId === p.id)} attempts={d.attempts.filter((a) => a.projectId === p.id)} />
  );
  return (
    <>
      <div className="ade-projlist">{activos.map(tarjeta)}</div>
      {archivados.length > 0 && (
        <details className="ade-archived">
          <summary>Archivados ({archivados.length})</summary>
          <div className="ade-projlist">{archivados.map(tarjeta)}</div>
        </details>
      )}
    </>
  );
}
