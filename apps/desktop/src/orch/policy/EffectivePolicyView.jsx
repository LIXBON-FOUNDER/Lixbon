// EffectivePolicyView.jsx — "Política efectiva": lo que se va a lanzar, antes de lanzarlo.
import { useEffect, useState } from 'react';
import { PROFILES, PROVIDERS, resolvePolicy as defaultResolver } from './resolvePolicy';
import { CODEX_CONFIG_MODEL_TEXT } from '../ModelInfo';
import './policy.css';

const STATUS_TEXT = { ok: 'Lista para lanzar', blocked: 'Bloqueada', unverified: 'No verificado' };
// Solo para mostrar: entrecomilla lo que un shell interpretaría (espacios, comillas, paréntesis, *).
const quote = (a) => (/[\s"'()*]/.test(a) || a === '' ? JSON.stringify(a) : a);
const LIST_FLAG = /^(--allowedTools|--disallowedTools)=(.*)$/;

/** Separa un token `--allowedTools=a,b` en flag y reglas; null si no es de lista. */
export function splitToolList(token) {
  const m = LIST_FLAG.exec(token);
  return m ? { flag: m[1], rules: m[2].split(',').filter(Boolean) } : null;
}

/** Solo presentación: las reglas de --allowedTools/--disallowedTools van una por línea.
    El argv que se envía al lanzar no cambia. */
function ArgvDisplay({ argv }) {
  if (!argv.length) return '—';
  return argv.map((a, i) => {
    const list = splitToolList(a);
    const sep = i ? ' ' : '';
    if (!list) return <span key={i}>{sep}{quote(a)}</span>;
    return (
      <span key={i} className="policy__toollist" data-testid="policy-toollist">
        {sep}{list.flag}=
        {list.rules.map((r) => <span key={r} className="policy__toolrule" data-testid="policy-toolrule">{r}</span>)}
      </span>
    );
  });
}

/**
 * @param {{ worktree: string, role?: string|null, model?: string|null, initialProvider?: string, initialProfile?: string,
 *   resolver?: import('./policyTypes').PolicyResolver,
 *   onLaunch?: (launch: import('./policyTypes').PolicyLaunch) => void }} props
 */
export function EffectivePolicyView({ worktree, role = null, model = null, initialProvider = 'claude', initialProfile = 'explorar', resolver = defaultResolver, onLaunch }) {
  const [provider, setProvider] = useState(initialProvider);
  const [profile, setProfile] = useState(initialProfile);
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState(null);
  // Confirmación explícita para lanzar con una versión de CLI no verificada.
  const [ackUnverified, setAckUnverified] = useState(false);

  useEffect(() => {
    let alive = true;
    setPolicy(null);
    setError(null);
    setAckUnverified(false);
    resolver(model ? { provider, profile, role, worktree, model } : { provider, profile, role, worktree })
      .then((p) => alive && setPolicy(p))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [provider, profile, role, worktree, model, resolver]);

  const isUnverified = policy?.status === 'unverified';
  // blocked nunca se lanza; unverified solo tras marcar la casilla.
  // Sin rol es solo una consulta de flags: no se lanza.
  const consultOnly = policy ? !policy.role : false;
  const canLaunch = Boolean(policy && !consultOnly && policy.status !== 'blocked' && policy.argv.length > 0 && (!isUnverified || ackUnverified));
  const launch = () => {
    if (!canLaunch) return;
    // Mismos nombres snake_case que espera spawn en el host: profile (id), argv, ack_unverified.
    onLaunch?.({ ...policy, ack_unverified: isUnverified });
  };
  const providerLabel = (id) => PROVIDERS.find((p) => p.id === id)?.label || id;
  const profileLabel = (id) => PROFILES.find((p) => p.id === id)?.label || id;

  return (
    <section className="policy" aria-label="Política efectiva">
      <h3 className="policy__title">Política efectiva</h3>
      <div className="policy__pickers">
        <fieldset className="policy__group">
          <legend>Proveedor</legend>
          {PROVIDERS.map((p) => (
            <label key={p.id}>
              <input type="radio" name="policy-provider" value={p.id} checked={provider === p.id} onChange={() => setProvider(p.id)} />
              {p.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="policy__group">
          <legend>Perfil</legend>
          {PROFILES.map((p) => (
            <label key={p.id} className={p.enabled ? '' : 'is-disabled'} title={p.disabledReason || undefined}>
              <input type="radio" name="policy-profile" value={p.id} checked={profile === p.id} disabled={!p.enabled} onChange={() => setProfile(p.id)} />
              {p.label}
              {!p.enabled && <span className="policy__muted"> — {p.disabledReason}</span>}
            </label>
          ))}
        </fieldset>
      </div>

      {error && <p role="alert" className="policy__error">No se pudo resolver la política: {error}</p>}
      {!policy && !error && <p className="policy__muted">Resolviendo…</p>}
      {policy && (
        <dl className="policy__details">
          <dt>Estado</dt>
          <dd data-testid="policy-status" className={`policy__status policy__status--${policy.status}`}>
            {STATUS_TEXT[policy.status] || policy.status}
            {policy.reason && <span className="policy__reason">: {policy.reason}</span>}
            {isUnverified && (
              <label className="policy__ack">
                <input type="checkbox" checked={ackUnverified} onChange={(e) => setAckUnverified(e.target.checked)} />
                Entiendo que esta versión no está verificada
              </label>
            )}
          </dd>
          <dt>Perfil</dt><dd>{profileLabel(policy.profile)}</dd>
          <dt>Rol</dt><dd data-testid="policy-role">{policy.role || 'Sin rol (solo consulta)'}</dd>
          <dt>Proveedor</dt><dd>{providerLabel(policy.provider)}</dd>
          {(model || policy.provider === 'codex') && <>
            <dt>Modelo pedido</dt>
            <dd data-testid="policy-model" className={model ? 'mono' : ''}>{model || CODEX_CONFIG_MODEL_TEXT}</dd>
          </>}
          <dt>Versión CLI detectada</dt><dd className="mono">{policy.cli_version || 'no detectada'}</dd>
          <dt>Comando (argv exacto)</dt>
          <dd><code data-testid="policy-argv" className="mono"><ArgvDisplay argv={policy.argv} /></code></dd>
          <dt>Advertencias</dt>
          <dd>
            {policy.warnings.length ? (
              <ul className="policy__warnings">{policy.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            ) : '—'}
          </dd>
        </dl>
      )}
      {consultOnly && <p className="policy__muted">Solo consulta: sin rol no se lanza ninguna tarea.</p>}
      <button type="button" className="policy__launch" disabled={!canLaunch} onClick={launch}>
        Lanzar
      </button>
    </section>
  );
}
