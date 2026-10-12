// IdeContextPanel.jsx — camino IDE → ADE: dado lo que el IDE tiene abierto (archivo, rama o worktree),
// muestra a qué Task/Intento pertenece, el estado del agente y su Attention, con atajos para saltar al ADE.
// La resolución ruta → intento es del Core (client.resolveLocation); el panel nunca adivina por prefijo.
import { useAdeQuery } from '../state/useAdeQuery';
import { useNow } from '../state/useNow';
import { LoadingState, ErrorState, EmptyState } from '../components/states';
import { StatusPill } from '../components/StatusMark';
import { AgentLabel } from '../components/AgentLabel';
import { NavLink } from '../components/NavLink';
import { buildAttentionViews } from '../domain-view/attention';
import { AttentionCard } from '../components/AttentionCard';
import { routes } from '../navigation/routes';

/** @param {{locator: {path?: string, worktreePath?: string, branch?: string}}} props */
export function IdeContextPanel({ locator }) {
  const now = useNow();
  const q = useAdeQuery(async (c) => {
    const loc = await c.resolveLocation(locator);
    if (!loc) return { loc: null };
    if (!loc.attemptId) return { loc, project: await c.getProject(loc.projectId) };
    const [attempt, task, project, attention] = await Promise.all([c.getAttempt(loc.attemptId), c.getTask(loc.taskId), c.getProject(loc.projectId), c.listAttention({ attemptId: loc.attemptId })]);
    return { loc, attempt, task, project, attention };
  }, [locator.path, locator.worktreePath, locator.branch]);

  if (q.data === null) return q.status === 'error' ? <ErrorState error={q.error} onRetry={q.reload} /> : <LoadingState rows={2} />;
  const { loc, attempt, task, project, attention } = q.data;
  if (!loc) return <EmptyState title="Fuera de cualquier intento" compact>Lo que tienes abierto no pertenece a ningún proyecto ni intento conocido.</EmptyState>;
  if (!attempt) {
    return (
      <section className="ade-idepanel" aria-label="Contexto del IDE">
        <p>Estás en el proyecto <NavLink route={routes.project(project.id)}>{project.name}</NavLink>, fuera de un worktree de intento.</p>
      </section>
    );
  }
  const vistas = buildAttentionViews(attention, { projects: [project], tasks: [task], attempts: [attempt] });
  return (
    <section className="ade-idepanel" aria-label="Contexto del IDE" data-testid="ide-context">
      <header>
        <NavLink route={routes.task(task.id)} className="ade-row__title">{task.title}</NavLink>
        <div className="ade-row__meta">
          <NavLink route={routes.attempt(attempt.id)}>Intento {attempt.ordinal}</NavLink>
          <AgentLabel agent={attempt.agent} />
          <StatusPill state={attempt.state} />
        </div>
      </header>
      {vistas.map((v) => <AttentionCard key={v.item.id} view={v} now={now} compact />)}
    </section>
  );
}
