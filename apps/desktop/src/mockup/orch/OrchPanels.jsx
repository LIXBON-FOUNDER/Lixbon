// OrchPanels.jsx — inspector de la derecha, detalle de un lanzamiento pendiente y las dos vistas globales: Flota y Equipo.
import React, { useState } from 'react';
import { useOrch, fleetCounts, validateRole, isFinal, isAwaiting, STATUS_LABEL } from './orchStore';
import { PROVIDERS, ROLES, PROFILES, ROLE_PROFILE, policyFor, POLICY_NOTES, RUN, PROJECT, OTHER_AGENTS, COORDINATOR_CFG } from './orchData';
import { AgentMark, AgentChip, Liveness, PlanTag, Seg, Empty, StatusMark, Txt, roleName, clock, money, tokensK, I } from './orchUi';

/* ── Inspector ───────────────────────────────────────────────────────────────────────────────────────── */
function Policy({ role, agent }) {
  const pol = policyFor(role, agent);
  const prof = PROFILES[pol.profile];
  return (
    <>
      <p className="o-kv"><span>Perfil</span><b>{prof.label}</b></p>
      <p className="o-meta">{prof.note}</p>
      <p className="o-kv"><span>Estado</span><b className="good">Lista para lanzar</b></p>
      <h3>Línea de lanzamiento</h3>
      <p className="o-argv mono">{pol.argv.map((a, i) => <span key={i}>{a.startsWith('--allowedTools=') || a.startsWith('--disallowedTools=') ? `${a.split('=')[0]}=…` : a} </span>)}</p>
      {a11yTools(pol.argv)}
      <h3>Límites reales</h3>
      <ul className="o-ul">{pol.warnings.map((w) => <li key={w}>{w}</li>)}{ROLES[role]?.readOnly && <li>Solo lectura: no puede editar archivos; trabaja en la carpeta del coordinador, sin rama.</li>}</ul>
    </>
  );
}
const a11yTools = (argv) => {
  const allowed = argv.find((a) => a.startsWith('--allowedTools='));
  if (!allowed) return null;
  return <ul className="o-rules mono">{allowed.split('=')[1].split(',').map((r) => <li key={r}>{r}</li>)}</ul>;
};

export function OrchInspector() {
  const s = useOrch();
  const t = s.tasks.find((x) => x.id === s.sel);
  const tab = s.inspectorTab;
  if (!t) return null;
  return (
    <aside className="o-insp" aria-label="Detalles de la tarea">
      <header className="o-insp__h">
        <Seg value={tab} onChange={s.setInspectorTab} label="Detalles" options={[{ id: 'encargo', label: 'Encargo' }, { id: 'politica', label: 'Política' }, { id: 'uso', label: 'Uso' }]} />
        <button type="button" className="o-ico" aria-label="Cerrar detalles" onClick={s.toggleInspector}><I n="x" size={13} /></button>
      </header>
      <div className="o-insp__body">
        {tab === 'encargo' && (
          <>
            <h3>{t.parent ? 'Encargo' : 'Objetivo del run'}</h3>
            <p className="o-spec"><Txt>{t.spec}</Txt></p>
            {t.report && <><h3>Informe</h3><button type="button" className="o-link mono" onClick={() => s.toast(`Abre ${t.report} en el editor`)}>{t.report}</button></>}
            {t.worktree && (<><h3>Worktree</h3><p className="o-meta mono">{t.worktree}</p></>)}
            {t.env && (
              <>
                <h3>Entorno del worktree</h3>
                <p className="o-meta">Enlazado con el repo (comparte los archivos): <span className="mono">{t.env.shared.join(', ')}</span></p>
                {t.env.copy?.length > 0 && <p className="o-meta">Copiado (copia propia; puede contener secretos): <span className="mono">{t.env.copy.join(', ')}</span></p>}
                {t.env.skipped?.length > 0 && <p className="o-meta">Omitido: {t.env.skipped.map((x) => `${x.path} (${x.reason})`).join(' · ')}</p>}
              </>
            )}
            {!t.parent && <><h3>Issue</h3><p className="o-meta">{RUN.issue} en «En curso». Al cerrar, el coordinador deja el resultado en la issue.</p></>}
          </>
        )}
        {tab === 'politica' && (t.role ? <Policy role={t.role} agent={t.agent} /> : <><p className="o-kv"><span>Rol</span><b>Coordinador</b></p><p className="o-meta">Es el chat con el que hablas. No integra: <span className="mono">lxo merge</span> y <span className="mono">lxo pr</span> se rechazan; la integración la confirmas tú.</p><AgentLine agent={COORDINATOR_CFG.agent} model={COORDINATOR_CFG.model} effort={COORDINATOR_CFG.effort} /></>)}
        {tab === 'uso' && (
          <>
            <p className="o-kv"><span>Coste</span><b>{money(t.cost)}</b></p>
            <p className="o-kv"><span>Tokens</span><b>{tokensK(t.tokens)}</b></p>
            <p className="o-kv"><span>Tiempo</span><b>{t.status === 'blocked' ? '—' : clock(t.min)}</b></p>
            {t.tests && <p className="o-kv"><span>Pruebas</span><b className={t.tests.pass === t.tests.total ? 'good' : ''}>{t.tests.pass}/{t.tests.total}</b></p>}
            <h3>Vivacidad <PlanTag phase="Fase 2" /></h3>
            <p className="o-kv"><span>Veredicto</span><Liveness live={t.live} /></p>
            <p className="o-meta">Combina proceso vivo, último latido (<span className="mono">lxo heartbeat</span>) y última salida del terminal. Perder contacto no produce «cerrado»: solo la prueba positiva permite detener o reintentar.</p>
          </>
        )}
      </div>
    </aside>
  );
}
const AgentLine = (p) => <p className="o-kv"><span>Agente</span><AgentChip {...p} size={14} /></p>;

/* ── Lanzamiento pendiente: cada `lxo spawn` lo aprueba una persona ──────────────────────────────────── */
export function SpawnDetail({ id }) {
  const s = useOrch();
  const p = s.pending.find((x) => x.id === id);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  if (!p) return <div className="o-view"><Empty>Este lanzamiento ya se resolvió o venció.</Empty></div>;
  const pol = policyFor(p.role, p.agent);
  const cfg = s.roles[p.role];
  return (
    <div className="o-view">
      <header className="o-title">
        <div>
          <h1>{p.name}</h1>
          <p className="o-title__sub">El coordinador pide lanzar un <b>{p.role}</b>. No arranca nada hasta que lo apruebes; vence en {Math.max(1, Math.round(p.expiresIn))} min.</p>
        </div>
      </header>
      <div className="o-two o-two--even">
        <section className="o-card">
          <header className="o-card__h"><h2>Qué se va a lanzar</h2></header>
          <p className="o-kv"><span>Rol</span><b>{roleName(p.role)}</b></p>
          <p className="o-kv"><span>Agente</span><AgentChip agent={p.agent} model={p.model} effort={p.effort} size={14} /></p>
          <p className="o-kv"><span>Dónde</span><b>{p.shared ? 'Carpeta del coordinador, sin rama' : 'Worktree propio y rama lx/…'}</b></p>
          <p className="o-kv"><span>Destino al integrar</span><b className="mono">{p.shared ? '—' : PROJECT.coordBranch}</b></p>
          <h3>Encargo</h3>
          <p className="o-spec"><Txt>{p.spec}</Txt></p>
          <p className="o-meta">El modelo lo fijó tu configuración de rol; el coordinador no puede cambiarlo.</p>
        </section>
        <section className="o-card">
          <header className="o-card__h"><h2>Política efectiva</h2></header>
          <Policy role={p.role} agent={p.agent} />
        </section>
      </div>
      <footer className="o-decide">
        <label className="o-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> He leído la política y la línea de lanzamiento</label>
        <div className="o-decide__reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo si lo rechazas (opcional)" aria-label="Motivo del rechazo" /></div>
        <button type="button" className="btn btn--ghost" onClick={() => s.rejectSpawn(p.id, reason || undefined)}>Rechazar</button>
        <button type="button" className="btn btn--accent" disabled={!ack} onClick={() => s.approveSpawn(p.id)}>Aprobar y lanzar</button>
      </footer>
    </div>
  );
}

/* ── Flota: todos los agentes de todas las carpetas (Plan · Fase 5) ──────────────────────────────────── */
export function FleetView() {
  const s = useOrch();
  const f = fleetCounts(s);
  const mine = s.tasks.map((t) => ({ id: t.id, title: t.parent ? t.title : RUN.title, repo: 'lixbon', role: t.role, agent: t.agent, model: t.model, status: t.status, min: t.min, cost: t.cost, live: t.live, run: 'Cerrar los pendientes del corte', mine: true }));
  const rows = [...mine.filter((r) => !['done'].includes(r.status) || true), ...OTHER_AGENTS];
  const active = rows.filter((r) => ['running', 'starting', 'awaiting_terminal_approval', 'blocked'].includes(r.status));
  const total = rows.reduce((n, r) => n + r.cost, 0);
  return (
    <div className="o-view">
      <header className="o-title">
        <div>
          <h1>Flota</h1>
          <p className="o-title__sub">{active.length} agentes activos en {new Set(active.map((r) => r.repo)).size} carpetas · {money(total)} gastados hoy. Incluye lo lanzado sin supervisión con <span className="mono">lxo handoff</span>. <PlanTag phase="Fase 5" /></p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => s.toast('Handoff: un agente en otro worktree, sin run ni espera (Plan · Fase 5)')}>Nuevo handoff</button>
      </header>
      <section className="o-card">
        <table className="o-tbl o-tbl--fleet">
          <thead><tr><th>Agente</th><th>Tarea</th><th>Carpeta · run</th><th>Estado</th><th>Vivacidad</th><th className="r">Tiempo</th><th className="r">Coste</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.mine && s.sel === r.id ? 'is-sel' : ''} onClick={() => r.mine && s.select(r.id)} style={{ cursor: r.mine ? 'pointer' : 'default' }}>
                <td><AgentChip agent={r.agent} model={r.model} size={14} /></td>
                <td><span className="o-cell-t">{r.title}</span><span className="o-meta">{r.role ? roleName(r.role) : r.handoff ? 'Handoff' : 'Coordinador'}</span></td>
                <td><span className="mono">{r.repo}</span><span className="o-meta">{r.run}</span></td>
                <td><span className="o-stat">{r.mine ? <StatusMark s={s} t={s.tasks.find((t) => t.id === r.id)} size={12} /> : <StatusMark s={s} t={{ status: r.status, parent: 'x' }} size={12} />}{STATUS_LABEL[r.status]}</span></td>
                <td>{['done', 'stopped'].includes(r.status) ? <span className="o-meta">—</span> : <Liveness live={r.live} />}</td>
                <td className="r num">{r.status === 'blocked' ? '—' : clock(r.min)}</td>
                <td className="r num">{money(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="o-meta o-foot">«Sin verificar» no significa muerto: el host no detiene ni reintenta un agente sin prueba positiva de que terminó. El handoff de lixbon-cli lleva más de 3 min sin latido: lo ves, y decides tú.</p>
      </section>
    </div>
  );
}

/* ── Equipo: Ajustes → Orquestador (roles → agente · modelo · esfuerzo) y registro de agentes ────────── */
function Select({ value, onChange, options, label, disabled }) {
  return (
    <span className="o-select">
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={disabled}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
      <I n="down" size={11} />
    </span>
  );
}

export function TeamView() {
  const s = useOrch();
  const [cap, setCap] = useState(RUN.budget.parallel);
  const ready = Object.values(PROVIDERS);
  return (
    <div className="o-view">
      <header className="o-title">
        <div>
          <h1>Equipo</h1>
          <p className="o-title__sub">Qué agente y qué modelo hace cada rol. El coordinador reparte por rol y no puede cambiar el modelo: así controlas el gasto.</p>
        </div>
      </header>

      <section className="o-card" aria-label="Roles">
        <header className="o-card__h"><h2>Roles</h2><span className="o-meta">Se valida al guardar: un rol de solo lectura nunca se asigna a un agente sin modo verificado</span></header>
        <table className="o-tbl o-tbl--roles">
          <thead><tr><th>Rol</th><th>Agente</th><th>Modelo</th><th>Esfuerzo</th><th>Acceso</th></tr></thead>
          <tbody>
            {Object.entries(s.roles).map(([role, cfg]) => {
              const p = PROVIDERS[cfg.agent];
              const agents = ready.filter((x) => x.state === 'ready').map((x) => ({ v: x.id, l: x.label + (ROLES[role].readOnly && x.readOnly !== 'verificado' ? ' · sin solo lectura' : '') }));
              return (
                <tr key={role}>
                  <td><span className="o-cell-t">{roleName(role)}</span><span className="o-meta">{ROLES[role].uso}</span></td>
                  <td><span className="o-agentsel"><AgentMark id={cfg.agent} size={18} /><Select label={`Agente de ${role}`} value={cfg.agent} options={agents} onChange={(v) => s.setRole(role, { agent: v })} /></span></td>
                  <td><Select label={`Modelo de ${role}`} value={cfg.model} options={p.models.map((m) => ({ v: m, l: m }))} onChange={(v) => s.setRole(role, { model: v })} /></td>
                  <td>{p.efforts.length ? <Select label={`Esfuerzo de ${role}`} value={cfg.effort} options={p.efforts.map((e) => ({ v: e, l: e }))} onChange={(v) => s.setRole(role, { effort: v })} /> : <span className="o-meta">—</span>}</td>
                  <td><span className="o-meta">{ROLES[role].readOnly ? 'Solo lectura' : 'Edita en su worktree'}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="o-two">
        <section className="o-card" aria-label="Agentes instalados">
          <header className="o-card__h"><h2>Agentes</h2><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast('Añadir un proveedor = una fila en ~/.lixbon/agents.json + captura de arranque + prueba (Plan · Fase 0)')}>Añadir proveedor <PlanTag phase="Fase 0" /></button></header>
          <ul className="o-prov-list">
            {ready.map((p) => (
              <li key={p.id} className={`is-${p.state}`}>
                <AgentMark id={p.id} size={22} />
                <span className="o-prov-list__main">
                  <span className="o-cell-t">{p.label}</span>
                  <span className="o-meta">{p.state === 'missing' ? 'No instalado' : `v${p.version} · ${p.mode} · solo lectura ${p.readOnly}`}</span>
                  {p.reason && <span className="o-meta o-prov-list__why">{p.reason}</span>}
                </span>
                <span className={`o-badge o-badge--${p.state === 'ready' ? 'good' : p.state === 'paused' ? 'warn' : ''}`}>{p.state === 'ready' ? 'Listo' : p.state === 'paused' ? 'Pausado' : 'Falta'}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="o-card" aria-label="Límites del run">
          <header className="o-card__h"><h2>Límites del run</h2><PlanTag phase="Fase 5" /></header>
          <label className="o-field"><span>Agentes en paralelo</span>
            <span className="o-step"><button type="button" aria-label="Menos" onClick={() => setCap((c) => Math.max(1, c - 1))}>−</button><b>{cap}</b><button type="button" aria-label="Más" onClick={() => setCap((c) => Math.min(8, c + 1))}>+</button></span>
          </label>
          <label className="o-field"><span>Coste máximo por run</span><b className="num">{money(RUN.budget.cost)}</b></label>
          <label className="o-field"><span>Cierre por inactividad</span><b className="num">30 min</b></label>
          <p className="o-meta">El coordinador no puede superar el tope. Un run sin actividad se cierra solo a los 30 min, pero el coordinador debe cerrarlo con <span className="mono">lxo run close</span>.</p>
        </section>
      </div>
    </div>
  );
}
