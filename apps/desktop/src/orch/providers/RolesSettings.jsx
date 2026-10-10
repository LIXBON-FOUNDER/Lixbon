// RolesSettings.jsx — Ajustes → Orquestador → Roles del equipo: proveedor por rol y,
// a partir de él, modelo y esfuerzo. Las listas salen de `orch_list_providers`.
import { useEffect, useState } from 'react';
import { Select } from '../../components/Select';
import { SectionHead } from '../../sections/Settings/SettingsParts';
import { resolvePolicy as defaultResolver } from '../policy/resolvePolicy';
import { DEFAULT_PROVIDER, UNVERIFIED_LABEL, providerLabel } from './providersContract';
import { profileName } from './NewAgentItems';
import { EMPTY_SAVE_WARNINGS, warningsForRole, dropClaudeOnly } from './roleSaveContract';
import { migrateRoleCfg, providerOptions, modelOptions, effortOptions, isModelVerified, profileForRole } from './roleConfig';

/** Advertencias de la política de solo lectura (las da orch_resolve_policy; aquí solo se pintan). */
function ReadOnlyWarnings({ role, provider, model, resolver }) {
  const [warnings, setWarnings] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setWarnings(null); setError(null);
    resolver({ provider, profile: profileForRole(true), role, worktree: '', model: model || null })
      // Política de Codex: nunca se cuelan avisos solo de Claude.
      .then((p) => alive && setWarnings(dropClaudeOnly(Array.isArray(p?.warnings) ? p.warnings : [], provider)))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [role, provider, model, resolver]);
  if (error) return <span className="srow__hint is-warn" role="alert">No se pudo leer la política de solo lectura: {error}</span>;
  if (!warnings) return <span className="srow__hint">Leyendo la política de solo lectura…</span>;
  if (!warnings.length) return null;
  return (
    <ul className="orch__rolewarn" data-testid={`role-warnings-${role}`} aria-label={`Advertencias de solo lectura de ${role}`}>
      {warnings.map((w) => <li key={w}>{w}</li>)}
    </ul>
  );
}

/**
 * @param {{ roles: Array<{id,label,purpose,read_only,model,effort,agent?}>, settings: object,
 *   providers: Array|null, onSave: (patch: object) => any, resolver?: Function }} props
 */
export function RolesSettings({ roles, settings, providers, onSave, resolver = defaultResolver, saveWarnings = EMPTY_SAVE_WARNINGS }) {
  const sw = saveWarnings || EMPTY_SAVE_WARNINGS;
  // Proveedor elegido aquí que el host aún no devolvió en su configuración.
  const [chosen, setChosen] = useState({});
  const list = providers || [];
  const cfgOf = (r) => migrateRoleCfg(settings.roles?.[r.id], { model: r.model, effort: r.effort });
  const save = (r, patch) => {
    const current = cfgOf(r);
    onSave({ roles: { ...settings.roles, [r.id]: { ...current, ...patch } } });
  };
  const pickProvider = (r, id) => {
    const p = list.find((x) => x.id === id);
    if (!p || !p.available) return;
    setChosen((c) => ({ ...c, [r.id]: id }));
    const cur = cfgOf(r);
    // Cambio explícito de proveedor: el modelo y el esfuerzo pasan a los del nuevo.
    const model = p.models.some((m) => m.id === cur.model) ? cur.model : (p.models[0]?.id || '');
    const effort = p.efforts.includes(cur.effort) ? cur.effort : '';
    save(r, { provider: id, model, effort });
  };

  return (
    <section className="ssec rise rise--2">
      <SectionHead
        label="Roles del equipo"
        hint="El coordinador planifica con el modelo de su chat y lanza a cada hija por rol, con el proveedor, modelo y esfuerzo que elijas aquí (no puede cambiarlos). Pon lo barato en lo que solo lee y reserva el caro para cuando haga falta."
      />
      <div className="ssec ssec--card ssec--rows">
        {providers === null && <span className="srow__hint">Consultando proveedores…</span>}
        {list.filter((p) => p.warnings?.length || p.blocked_profiles?.length).map((p) => (
          <div key={p.id} className="orch__rolewarn" role="note" data-testid={`provider-warnings-${p.id}`}>
            <strong>{providerLabel(p.id)}</strong>
            <ul>
              {(p.warnings || []).map((w) => <li key={w}>{w}</li>)}
              {(p.blocked_profiles || []).map((b) => (
                <li key={b.profile} className="is-disabled" aria-disabled="true" data-testid={`provider-blocked-${p.id}-${b.profile}`}>{profileName(b.profile)} (bloqueado): {b.reason}</li>
              ))}
            </ul>
          </div>
        ))}
        {sw.flat?.length > 0 && (
          <ul className="orch__rolewarn" data-testid="roles-save-warnings" aria-label="Avisos al guardar los roles">
            {sw.flat.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        {roles.map((r) => {
          const cfg = cfgOf(r);
          const stored = settings.roles?.[r.id]?.provider;
          // La fila muestra lo que tiene el host (settings.roles por clave), no lo elegido sin guardar.
          const providerId = cfg.provider || DEFAULT_PROVIDER;
          const roleWarnings = warningsForRole(sw, r.id, providerId);
          const provider = list.find((p) => p.id === providerId);
          const model = cfg.model || r.model || '';
          const effort = cfg.effort ?? r.effort ?? '';
          const notSaved = chosen[r.id] && chosen[r.id] !== (stored || DEFAULT_PROVIDER);
          const hostAgent = r.agent && r.agent !== providerId ? r.agent : null;
          return (
            <div key={r.id} className="srow" data-testid={`role-${r.id}`}>
              <div className="srow__text">
                <span className="srow__label">
                  {r.label} {r.read_only && <span className="orch__pill is-ok">Solo lectura</span>}
                  {model && provider && !isModelVerified(provider, model) && <span className="orch__pill is-warn" data-testid={`role-unverified-${r.id}`}>{UNVERIFIED_LABEL}</span>}
                </span>
                <span className="srow__hint">{r.purpose}</span>
                {provider && !provider.available && (
                  <span className="srow__hint is-warn" data-testid={`role-provider-off-${r.id}`}>{providerLabel(provider.id)} no disponible: {provider.disabled_reason || 'sin motivo del host'}</span>
                )}
                {(notSaved || hostAgent) && (
                  <span className="srow__hint is-warn" role="alert" data-testid={`role-host-agent-${r.id}`}>
                    El host todavía lanza este rol con {providerLabel(hostAgent || stored || DEFAULT_PROVIDER)}: no guardó el proveedor elegido.
                  </span>
                )}
                {roleWarnings.length > 0 && (
                  <ul className="orch__rolewarn" data-testid={`role-save-warnings-${r.id}`} aria-label={`Avisos al guardar ${r.label}`}>
                    {roleWarnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                )}
                {r.read_only && providerId === 'codex' && <ReadOnlyWarnings role={r.id} provider="codex" model={model} resolver={resolver} />}
              </div>
              <div className="orch__rolectl">
                <Select className="select--fill" value={providerId} onChange={(id) => pickProvider(r, id)}
                  options={list.length ? providerOptions(list) : [{ value: providerId, label: providerLabel(providerId) }]}
                  title={`Proveedor del ${r.label.toLowerCase()}`} />
                <Select className="select--fill" value={model} onChange={(m) => save(r, { provider: providerId, model: m })}
                  options={modelOptions(provider, model)} title={`Modelo del ${r.label.toLowerCase()}`} />
                <Select className="select--fill" value={effort} onChange={(e) => save(r, { provider: providerId, effort: e })}
                  options={effortOptions(provider, effort)} title={`Esfuerzo del ${r.label.toLowerCase()}`} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Lista de proveedores del host (o del mock en desarrollo). */
export function useProviders(load) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const refresh = async (refresh = false) => {
    try { setProviders(await load({ refresh })); setError(null); } catch (e) { setProviders([]); setError(String(e?.message || e)); }
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { providers, error, refresh };
}
