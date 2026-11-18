const STATUS = {
  fresh: 'Al día', stale: 'Dato antiguo', unknown: 'Sin datos de uso',
  unsupported: 'No informa de su uso', environment_blocked: 'Consulta bloqueada por el entorno',
};
export const USAGE_ERRORS = {
  auth_required: 'Inicia sesión en el proveedor desde el escritorio.',
  rate_limited: 'El proveedor limita las consultas. Espera antes de actualizar.',
  provider_unavailable: 'El proveedor no respondió a la consulta de uso.',
  unsupported: 'El proveedor no informa de su uso.',
  environment_blocked: 'Revisa el entorno en el escritorio.',
  internal: 'No se pudo completar la consulta de uso.',
};
const FIELDS = { windows: 'Cuota', tokens: 'Tokens', credits: 'Créditos', plan: 'Plan', cost: 'Coste' };
const FIELD_STATES = { unsupported: 'no soportado', unavailable: 'no disponible ahora', environment_blocked: 'bloqueado por el entorno' };
const WINDOWS = { primary: 'Ventana principal', secondary: 'Ventana secundaria', five_hour: 'Ventana de 5 horas', seven_day: 'Semana' };
const quantity = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('es') : 'sin dato';

export function usageCard(provider, { stale = false, now = Date.now() } = {}) {
  const snapshot = provider.snapshot;
  const old = stale || provider.status === 'stale'
    || (Number.isFinite(snapshot?.observed_at_ms) && now - snapshot.observed_at_ms >= 300000);
  const support = provider.support || {};
  const metrics = [];
  const supported = (field) => support[field] === 'available';
  for (const [key, label] of Object.entries(FIELDS)) {
    if (!supported(key)) metrics.push({ label, text: FIELD_STATES[support[key]] || 'sin dato' });
  }
  if (supported('plan')) metrics.push({ label: 'Plan', text: snapshot?.plan || 'sin dato' });
  if (supported('credits')) {
    const credits = snapshot?.credits;
    let text = 'sin dato';
    if (credits?.unlimited === true) text = 'Sin límite declarado';
    else if (credits?.balance != null) text = credits.balance;
    else if (credits?.has_credits === false) text = 'Sin créditos disponibles';
    metrics.push({ label: 'Créditos', text });
  }
  const windows = supported('windows') ? (snapshot?.windows || []).map((window) => ({
    id: window.id,
    label: WINDOWS[window.id] || window.id,
    value: Number.isFinite(window.used_percent) ? `${window.used_percent} % usado` : 'Uso sin dato',
    minutes: Number.isSafeInteger(window.minutes) ? `${window.minutes} min` : null,
    resetsAt: window.resets_at,
  })) : [];
  const models = (snapshot?.models || []).map((model) => ({
    name: model.model,
    tokens: supported('tokens') ? `${quantity(model.input_tokens)} entrada · ${quantity(model.output_tokens)} salida` : null,
    cost: supported('cost') ? (Number.isFinite(model.cost_usd) ? `${model.cost_usd} USD` : 'sin dato') : null,
  }));
  if (supported('windows') && windows.length === 0) metrics.push({ label: 'Cuota', text: 'sin dato' });
  if (supported('tokens') && models.length === 0) metrics.push({ label: 'Tokens', text: 'sin dato' });
  if (supported('cost') && models.length === 0) metrics.push({ label: 'Coste', text: 'sin dato' });
  return {
    name: provider.provider,
    status: old && snapshot ? 'Dato antiguo' : STATUS[provider.status] || 'Sin información',
    tone: old || provider.error || provider.status === 'environment_blocked' ? 'warn' : 'muted',
    account: /^[a-f0-9]{8}$/.test(snapshot?.account || '') ? snapshot.account : null,
    observedAt: snapshot?.observed_at_ms,
    provenance: { provider_query: 'Consulta al proveedor', run_observation: 'Declarado durante una ejecución' }[snapshot?.provenance] || null,
    error: USAGE_ERRORS[provider.error] || null,
    limitReached: snapshot?.limit_reached === true,
    throttled: provider.throttled,
    truncated: provider.truncated,
    metrics, windows, models,
  };
}
