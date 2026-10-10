// ModelInfo.jsx — modelo pedido y modelo que respondió en una tarea o intento.
// Solo pinta lo que trae el snapshot del host (model_requested, model_effective,
// model_mismatch, model_mismatch_reason); no decide si hay discrepancia.

export const MODEL_MISMATCH_TEXT = 'Respondió un modelo distinto del pedido';
/** Codex sin --model: lo decide su config.toml; la UI no inventa nombre. */
export const CODEX_CONFIG_MODEL_TEXT = 'el que defina config.toml';
export const PLAN_MODE_TEXT = 'en modo plan, Claude responde con Sonnet aunque pidas otro modelo';

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** Datos de modelo de una tarea; tolera snapshots viejos sin estos campos. */
export function modelInfo(task) {
  const requested = str(task?.model_requested);
  const effective = str(task?.model_effective);
  // Sin modelo pedido no hay con qué comparar: nunca se avisa de discrepancia.
  const mismatch = Boolean(requested) && task?.model_mismatch === true;
  const fromConfig = !requested && task?.agent === 'codex';
  return { requested, effective, mismatch, fromConfig, planMode: mismatch && task?.model_mismatch_reason === 'plan_mode' };
}

/** Bloque para la cabecera de la tarea. Sin campos de modelo no pinta nada. */
export function ModelInfo({ task }) {
  const { requested, effective, mismatch, planMode, fromConfig } = modelInfo(task);
  if (!requested && !effective && !fromConfig) return null;
  return (
    <div className={`orch__model ${mismatch ? 'is-mismatch' : ''}`} data-testid="task-model">
      {requested && <span>Pedido: <span className="mono" data-testid="model-requested">{requested}</span></span>}
      {fromConfig && <span>Pedido: <span data-testid="model-requested-config">{CODEX_CONFIG_MODEL_TEXT}</span></span>}
      {(requested || fromConfig) && effective && ' · '}
      {effective && <span>Respondió: <span className="mono" data-testid="model-effective">{effective}</span></span>}
      {mismatch && (
        <div role="alert" className="orch__model-warn" data-testid="model-mismatch">
          ⚠ {MODEL_MISMATCH_TEXT}{planMode && <>: {PLAN_MODE_TEXT}</>}
        </div>
      )}
    </div>
  );
}

/** Marca compacta para la fila de la tarea. */
export function ModelMismatchBadge({ task }) {
  const { mismatch, planMode } = modelInfo(task);
  if (!mismatch) return null;
  return (
    <span className="orch__badge orch__badge--warn" data-testid="model-mismatch-badge"
      title={planMode ? `${MODEL_MISMATCH_TEXT}: ${PLAN_MODE_TEXT}` : MODEL_MISMATCH_TEXT}>
      modelo distinto
    </span>
  );
}
