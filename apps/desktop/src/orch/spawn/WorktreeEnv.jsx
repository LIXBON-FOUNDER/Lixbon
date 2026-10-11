/** Qué se lleva el worktree de una tarea del repo (orch/worktree_env.rs): enlaces y copias. */
export function WorktreeEnv({ env, done = false }) {
  const shared = env?.shared || [];
  const copy = env?.copy || [];
  const skipped = env?.skipped || [];
  if (!shared.length && !copy.length && !skipped.length) return null;
  const list = (items) => items.map((p) => <span key={p} className="mono wtenv__path">{p}</span>);
  return (
    <section className="wtenv" aria-label="Entorno del worktree" data-testid="worktree-env">
      <span className="wtenv__title">Entorno del worktree</span>
      {shared.length > 0 && (
        <p data-testid="worktree-env-shared">
          {done ? 'Enlazado' : 'Se enlazará'} con el repo (comparte los archivos): {list(shared)}
        </p>
      )}
      {copy.length > 0 && (
        <p data-testid="worktree-env-copy">
          {done ? 'Copiado' : 'Se copiará'} (copia propia; puede contener secretos): {list(copy)}
        </p>
      )}
      {skipped.length > 0 && (
        <p className="wtenv__skipped" data-testid="worktree-env-skipped">
          Omitido: {skipped.map((s) => `${s.path} (${s.reason})`).join(' · ')}
        </p>
      )}
    </section>
  );
}
