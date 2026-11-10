import './AttemptCompare.css';

/**
 * La procedencia de un dato, igual en Compare y en el Proof Pack (LXO-154/155): glifo + texto + forma de borde (no solo color).
 * `verified` lo comprobó el Core; `agent_reported` lo declaró el agente; `unknown` no hay dato (con su motivo; nunca un cero).
 */
export const PROVENANCE_VIEW = Object.freeze({
  verified: { glyph: '✓', label: 'Verificado por el Core' },
  agent_reported: { glyph: '⚠', label: 'Lo dice el agente' },
  unknown: { glyph: '?', label: 'Sin dato' },
});

export const REASONS = Object.freeze({
  no_worktree: 'aún no tiene worktree',
  not_current_attempt: 'ya no es el intento actual de su tarea: la rama es la del actual',
  branch_unavailable: 'la rama ya no existe',
  no_base: 'no hay commit base',
  repo_unavailable: 'el repositorio no está disponible',
  git_unavailable: 'git no pudo calcularlo',
  truncated: 'la lista se recortó: las sumas no valen',
  binary_files: 'hay archivos binarios sin cuentas de líneas',
  not_reviewed: 'no se ha revisado',
  no_summary: 'el agente no dejó resumen',
  no_objective: 'la tarea no tiene objetivo',
  none_recorded: 'no hay artefactos registrados',
  not_collected: 'el Core aún no recoge resultados de pruebas',
});

export function Mark({ provenance, reason }) {
  const view = PROVENANCE_VIEW[provenance];
  return (
    <span className={`cmp-prov cmp-prov--${provenance}`} data-testid="cmp-prov">
      <span aria-hidden="true">{view.glyph}</span> {view.label}
      {provenance === 'unknown' && reason && <span className="cmp-prov__reason"> — {REASONS[reason] ?? reason}</span>}
    </span>
  );
}
