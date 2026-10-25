// PreviewFleet.jsx — Mapa, Hosts y Uso. La computación y el consumo son contexto de cada decisión,
// no un panel financiero. El mapa es una vista avanzada para mucho paralelismo; no es el inicio.
import { useMemo, useState } from 'react';
import { providerName } from '../../orch/agent/agentIdentity';
import { usePreviewStore, attemptsOfTask, hostCount } from './previewStore';
import { EDGES, PROJECTS, USAGE, RESOURCES } from './previewData';
import { Mark, AttnFlag, Agent, Meter, SimBadge, Tabs } from './PreviewUi';
import { stateLabel, hostOf, money, kTokens } from './previewVocab';

const W = 224;
const H = 90;

export function PreviewMap() {
  const s = usePreviewStore();
  const [projectId, setProjectId] = useState(s.sel.projectId);
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const ids = new Set(tasks.map((t) => t.id));
  const edges = EDGES.filter((e) => ids.has(e.from) && ids.has(e.to));
  const layout = useMemo(() => {
    const depth = Object.fromEntries(tasks.map((t) => [t.id, 0]));
    for (let k = 0; k < tasks.length; k += 1) {
      edges.filter((e) => e.kind === 'child' || e.kind === 'blocks').forEach((e) => { depth[e.to] = Math.max(depth[e.to], depth[e.from] + 1); });
    }
    const cols = {};
    tasks.forEach((t) => { (cols[depth[t.id]] = cols[depth[t.id]] || []).push(t); });
    const pos = {};
    Object.entries(cols).forEach(([d, list]) => list.forEach((t, i) => { pos[t.id] = { x: 150 + Number(d) * 380, y: 24 + i * 120, col: Number(d) }; }));
    const all = Object.values(pos);
    return { pos, w: Math.max(...all.map((p) => p.x), 0) + W + 40, h: Math.max(...all.map((p) => p.y), 0) + H + 30 };
  }, [projectId, tasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const route = (e, k) => {
    const a = layout.pos[e.from];
    const b = layout.pos[e.to];
    if (a.col === b.col) {
      const off = 56 + k * 34;
      const y1 = a.y + H / 2;
      const y2 = b.y + H / 2;
      return `M${a.x} ${y1} C ${a.x - off} ${y1}, ${b.x - off} ${y2}, ${b.x} ${y2}`;
    }
    const fwd = a.col < b.col;
    const x1 = fwd ? a.x + W : a.x;
    const x2 = fwd ? b.x : b.x + W;
    const c = Math.abs(x2 - x1) / 2;
    return `M${x1} ${a.y + H / 2} C ${x1 + (fwd ? c : -c)} ${a.y + H / 2}, ${x2 - (fwd ? c : -c)} ${b.y + H / 2}, ${x2} ${b.y + H / 2}`;
  };
  let same = 0;
  return (
    <div className="pv-pad pv-map">
      <header className="pv-view__head">
        <h1 className="pv-view__title">Mapa</h1>
        <span className="pv-tag pv-tone-waiting">experimental</span>
        <span className="pv-muted">Dependencias e intención entre Tasks en paralelo.</span>
        <span className="panelhead__fill" />
        <Tabs value={projectId} onChange={setProjectId} label="Project" options={PROJECTS.map((p) => ({ id: p.id, label: p.name }))} />
      </header>
      <div className="pv-map__canvas scroll">
        <svg width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} role="img" aria-label="Mapa de dependencias entre Tasks">
          <defs><marker id="pv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="currentColor" /></marker></defs>
          {edges.map((e, i) => {
            const k = layout.pos[e.from].col === layout.pos[e.to].col ? same++ : 0;
            return <path key={i} className={`pv-edge pv-edge--${e.kind}`} d={route(e, k)} fill="none" markerEnd="url(#pv-arrow)" />;
          })}
          {tasks.map((t) => {
            const p = layout.pos[t.id];
            const atts = attemptsOfTask(s, t.id);
            const attn = atts.reduce((n, a) => n + s.attention.filter((x) => x.attemptId === a.id).length, 0);
            return (
              <foreignObject key={t.id} x={p.x} y={p.y} width={W} height={H}>
                <button type="button" className={`pv-node${s.sel.taskId === t.id ? ' is-sel' : ''}`} onClick={() => s.select(atts[0].id)}>
                  <span className="pv-node__title pv-trunc">{t.title}</span>
                  <span className="pv-node__marks">{atts.map((a) => <span key={a.id} title={`Intento ${a.label} · ${stateLabel(a)}`}><Mark attempt={a} size={12} /></span>)}<span className="panelhead__fill" />{attn > 0 && <AttnFlag n={attn} />}</span>
                  {t.run && <span className="pv-node__run pv-trunc">Run · {t.run}</span>}
                </button>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      <div className="pv-map__legend">
        <span><i className="pv-legend pv-edge--child" /> hija del Run coordinador</span>
        <span><i className="pv-legend pv-edge--blocks" /> bloquea (dependencia de intención)</span>
        <span><i className="pv-legend pv-edge--overlaps" /> tocan los mismos archivos</span>
        <span><i className="pv-legend pv-edge--conflict" /> conflicto</span>
      </div>
      {edges.some((e) => e.kind === 'overlaps') && (
        <div className="pv-callout"><span><b>Riesgo de intención:</b> Renovación OAuth y Runtime de agentes reescriben <span className="mono">src/auth/token.ts</span> y <span className="mono">session.ts</span> con supuestos distintos. Git aún no ve conflicto.</span></div>
      )}
    </div>
  );
}

export function PreviewHosts() {
  const s = usePreviewStore();
  return (
    <div className="pv-pad scroll">
      <header className="pv-view__head"><h1 className="pv-view__title">Hosts</h1><span className="pv-muted">Dónde corre de verdad cada Intento. El host es el dueño de la ejecución; ADE, móvil y CLI solo observan y deciden.</span></header>
      <div className="pv-hosts">
        {s.hosts.map((h) => {
          const atts = s.attempts.filter((a) => a.host === h.id);
          return (
            <article key={h.id} className={`pv-host${h.status === 'offline' ? ' is-off' : ''}`}>
              <header><span className={`dot ${h.status === 'online' ? 'dot--good' : ''}`} /><b>{h.name}</b><span className="pv-tag pv-tag--dim">{h.transport}</span><span className="panelhead__fill" /><span className={h.status === 'online' ? 'pv-good' : 'pv-muted'}>{h.status === 'online' ? 'Conectado' : 'Desconectado'}</span></header>
              <div className="pv-muted">{h.os} · {h.note}</div>
              <div><b className="mono">{hostCount(s, h.id)}</b> Intentos · {atts.filter((a) => a.state === 'working').length} en ejecución</div>
              <ul className="pv-host__list">
                {atts.slice(0, 5).map((a) => <li key={a.id}><button type="button" onClick={() => s.select(a.id)}><Mark attempt={a} size={12} /><span className="pv-trunc">{s.tasks.find((t) => t.id === a.taskId).title}</span><span className="pv-muted">{providerName(a.provider)}</span></button></li>)}
                {atts.length > 5 && <li className="pv-muted">+{atts.length - 5} más</li>}
                {!atts.length && <li className="pv-muted">Sin Intentos</li>}
              </ul>
              <footer><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toggleHost(h.id)}><SimBadge />{h.status === 'online' ? 'Desconectar' : 'Reconectar'}</button></footer>
            </article>
          );
        })}
      </div>
      <h2 className="ssec__label pv-subhead">Recursos · los worktrees ocupan disco; nada sin integrar se borra sin confirmarlo</h2>
      <table className="pv-table">
        <thead><tr><th>Worktree</th><th>Host</th><th>Tamaño</th><th>Última actividad</th><th>Git</th><th /></tr></thead>
        <tbody>
          {RESOURCES.map((r) => {
            const safe = r.git === 'merged' || r.git === 'clean';
            return (
              <tr key={r.name}>
                <td>{r.name}</td><td>{r.host}</td><td className="mono">{r.size}</td><td className="pv-muted">hace {r.last}</td>
                <td><span className={`pv-tag ${safe ? 'pv-tone-done' : 'pv-tone-waiting'}`}>{{ clean: 'limpio', merged: 'integrado', unmerged: 'sin integrar', dirty: 'con cambios' }[r.git]}</span></td>
                <td><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast(safe ? `${r.name}: archivado (simulado).` : `${r.name}: bloqueado, tiene trabajo sin integrar. Ábrelo antes.`)}>Archivar</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PreviewUsage() {
  const s = usePreviewStore();
  const [budgets, setBudgets] = useState({ t_runtime: 5, t_oauth: 2 });
  const spentByTask = (taskId) => s.attempts.filter((a) => a.taskId === taskId).reduce((n, a) => n + a.cost, 0);
  return (
    <div className="pv-pad scroll">
      <header className="pv-view__head"><h1 className="pv-view__title">Uso</h1><span className="pv-muted">Para decidir qué agente seguir usando, no para auditar gastos.</span></header>
      {USAGE.filter((u) => u.pct >= 70).map((u) => (
        <div key={u.provider} className="pv-callout"><span><b>{providerName(u.provider)} · {u.windowLabel}: {u.pct}% usado</b> · se reinicia en {u.reset}. Los Intentos nuevos preguntarán antes de usarlo. Lixbon nunca cambia de proveedor sin decírtelo.</span></div>
      ))}
      <div className="pv-usage">
        {USAGE.map((u) => {
          const atts = s.attempts.filter((a) => a.provider === u.provider);
          return (
            <article key={u.provider} className="pv-usage__card">
              <header><Agent attempt={{ provider: u.provider }} detail={false} size={14} /><span className="panelhead__fill" /><span className="pv-muted">{u.windowLabel}</span></header>
              <div className="pv-usage__big"><div><small>Hoy</small><b className="mono">{money(u.today)}</b></div><div><small>Tokens</small><b className="mono">{u.tokens}</b></div><div><small>Intentos</small><b className="mono">{atts.length}</b></div></div>
              <div className="pv-usage__meter"><Meter pct={u.pct} /><span className="mono">{u.pct}%</span><span className="pv-muted">· se reinicia {u.reset}</span></div>
              <p className="pv-muted">{u.hint}</p>
            </article>
          );
        })}
      </div>

      <h2 className="ssec__label pv-subhead">Presupuesto por Task · al llegar al límite los Intentos se pausan en un punto seguro y te preguntan</h2>
      <table className="pv-table">
        <thead><tr><th>Task</th><th className="num">Gastado</th><th>Límite</th><th /></tr></thead>
        <tbody>
          {s.tasks.filter((t) => attemptsOfTask(s, t.id).some((a) => a.cost > 0)).map((t) => {
            const spent = spentByTask(t.id);
            const limit = budgets[t.id];
            const pct = limit ? Math.round((spent / limit) * 100) : null;
            return (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td className="num mono">{money(spent)}</td>
                <td>
                  <label className="pv-budget">
                    <span className="pv-muted">parar a $</span>
                    <input type="number" min="0" step="0.5" value={limit ?? ''} placeholder="—" aria-label={`Límite de gasto para ${t.title}`} onChange={(e) => setBudgets((b) => ({ ...b, [t.id]: e.target.value === '' ? undefined : Number(e.target.value) }))} />
                  </label>
                </td>
                <td>{pct != null && <span className="pv-usage__meter"><Meter pct={pct} /><span className="mono">{pct}%</span></span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="ssec__label pv-subhead">Por Intento · de mayor a menor gasto</h2>
      <table className="pv-table">
        <thead><tr><th>Task · Intento</th><th>Agente</th><th>Estado</th><th>Host</th><th className="num">Tokens</th><th className="num">Coste</th></tr></thead>
        <tbody>
          {[...s.attempts].sort((a, b) => b.cost - a.cost).map((a) => (
            <tr key={a.id}>
              <td><button type="button" className="lk pv-trunc" onClick={() => s.select(a.id)}>{s.tasks.find((t) => t.id === a.taskId).title} · {a.label}</button></td>
              <td><Agent attempt={a} detail={false} /></td>
              <td><span className="pv-wrap"><Mark attempt={a} size={12} />{stateLabel(a)}</span></td>
              <td className="pv-muted">{hostOf(a.host).name}</td>
              <td className="num mono">{kTokens(a.tokens)}</td>
              <td className="num mono">{money(a.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan="4">Total · estimado, simulado</td><td className="num mono">{kTokens(s.attempts.reduce((n, a) => n + a.tokens, 0))}</td><td className="num mono">{money(s.attempts.reduce((n, a) => n + a.cost, 0))}</td></tr></tfoot>
      </table>
    </div>
  );
}
