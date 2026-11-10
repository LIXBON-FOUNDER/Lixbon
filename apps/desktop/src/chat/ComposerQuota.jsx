// ComposerQuota.jsx — el sitio del compositor donde se ve la cuota del plan de Claude (sesión y semana).
// Es esencial como el modelo, el effort, adjuntar y enviar: nunca se oculta del todo al estrechar el panel
// (solo pierde el número y queda el anillo). Un clic abre «Uso y límites».
import { useClaudeUsage } from '../store/claudeSession';
import { useAppStore } from '../store/appStore';
import { liveWindow } from '../lib/claudeUsage';
import { ProgressRing } from '../components/Ring';

const clamp = (value) => Math.min(100, Math.max(0, Math.round(value ?? 0)));

/** `{ session, week }` en porcentaje, o `null` en la ventana que Claude Code todavía no ha informado. */
export function quotaOf(usage) {
  const session = liveWindow(usage?.session);
  const week = liveWindow(usage?.week);
  return { session: session ? clamp(session.percent) : null, week: week ? clamp(week.percent) : null };
}

export function quotaTitle({ session, week }) {
  if (session === null && week === null) {
    return 'Cupo del plan de Claude: aún sin datos. Se actualiza con la primera respuesta o con /usage. Clic para ver el consumo.';
  }
  const part = (label, value) => (value === null ? `${label} sin datos` : `${label} ${value}%`);
  return `Cupo del plan de Claude · ${part('sesión', session)} · ${part('semana', week)}. Clic para ver el consumo.`;
}

export function ComposerQuota() {
  const usage = useClaudeUsage();
  const quota = quotaOf(usage);
  // El anillo sigue a la sesión (la ventana que se agota primero); sin ella, a la semana.
  const ring = quota.session ?? quota.week;
  const shown = quota.session ?? quota.week;
  return (
    <button
      type="button"
      className="chat-inputbar__quota"
      data-testid="composer-quota"
      title={quotaTitle(quota)}
      aria-label={quotaTitle(quota)}
      onClick={() => useAppStore.getState().openModal('settings', 'usage')}
    >
      <ProgressRing value={ring ?? 0} size={16} stroke={3} />
      <span className="chat-inputbar__quota-pct mono">{shown === null ? '—' : `${shown}%`}</span>
    </button>
  );
}
