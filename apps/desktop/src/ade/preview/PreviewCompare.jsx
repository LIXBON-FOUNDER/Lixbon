// PreviewCompare.jsx — Intentos de la MISMA Task con el MISMO ContextPackage, lado a lado.
// Arriba el resumen (cifras y decisión, siempre a la vista); abajo la exploración con scroll propio.
// «Componer»: en vez de elegir un ganador entero, tomar cada archivo del Intento que lo hizo mejor
// y arrancar con eso un Intento combinado. Diferencias = hechos de la tabla, no un veredicto.
import { useMemo, useState } from 'react';
import { usePreviewStore, attemptsOfTask, taskOf, attemptById, timelineOf } from './previewStore';
import { PROOF_PACKS, REVIEW_FILES } from './previewData';
import { Agent, Loc, StatePill, I, Tabs } from './PreviewUi';
import { money, kTokens, RISK_LABEL, agentName } from './previewVocab';

const APPROACH = {
  att_oa_a: 'Rota el token en el sitio y mantiene una caducidad deslizante de respaldo. Aún valora la compatibilidad con sesiones vivas.',
  att_oa_b: PROOF_PACKS.att_oa_b.approach,
  att_rt_a: 'Máquina de estados con eventos; el gestor de worktrees resuelve rutas por ProjectLocation.',
  att_rt_b: PROOF_PACKS.att_rt_b.approach,
};
const WARN = { att_oa_a: 0, att_oa_b: 1, att_rt_a: 0, att_rt_b: 3 };

function best(vals, dir) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return -1;
  const t = dir === 'min' ? Math.min(...v) : Math.max(...v);
  return vals.filter((x) => x === t).length > 1 ? -1 : vals.indexOf(t);
}

function deltas(a, b) {
  const out = [];
  const files = b.files - a.files;
  if (files) out.push(`${Math.abs(files)} archivos ${files > 0 ? 'más' : 'menos'}`);
  const lines = (b.add - b.del) - (a.add - a.del);
  if (lines) out.push(`${lines > 0 ? '+' : ''}${lines} líneas netas`);
  const min = b.minutes - a.minutes;
  if (min) out.push(`${Math.abs(min)} min ${min < 0 ? 'más rápido' : 'más lento'}`);
  const cost = +(b.cost - a.cost).toFixed(2);
  if (cost) out.push(`${money(Math.abs(cost))} ${cost < 0 ? 'más barato' : 'más caro'}`);
  return out;
}

const filesOf = (s, a) => REVIEW_FILES[a.id] || timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files);

function Compose({ atts, s, task }) {
  const byPath = useMemo(() => {
    const map = new Map();
    atts.forEach((a) => filesOf(s, a).forEach((f) => {
      if (!map.has(f.path)) map.set(f.path, {});
      map.get(f.path)[a.id] = f;
    }));
    return [...map.entries()].sort(([x], [y]) => x.localeCompare(y));
  }, [atts, s]);
  const [pick, setPick] = useState({});
  const chosen = byPath.filter(([path]) => pick[path]);
  const start = () => {
    const parts = chosen.map(([path]) => `${path} del Intento ${atts.find((a) => a.id === pick[path]).label}`);
    s.fork({ attemptId: atts[0].id, provider: atts[0].provider, model: atts[0].model, host: atts[0].host, text: `Combina: ${parts.join('; ')}. El resto, como el Intento ${atts[0].label}.` });
  };
  return (
    <div className="pv-compose">
      <p className="pv-muted">Elige de qué Intento tomar cada archivo. Se arranca un Intento nuevo que combina lo elegido; los originales no se tocan.</p>
      <table className="pv-table">
        <thead><tr><th>Archivo</th>{atts.map((a) => <th key={a.id}>Intento {a.label}</th>)}</tr></thead>
        <tbody>
          {byPath.map(([path, per]) => (
            <tr key={path}>
              <td className="mono pv-trunc" title={path}>{path}</td>
              {atts.map((a) => {
                const f = per[a.id];
                if (!f) return <td key={a.id} className="pv-muted">sin cambios</td>;
                const on = pick[path] === a.id;
                return (
                  <td key={a.id}>
                    <button type="button" className={`pv-chipbtn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => setPick((p) => ({ ...p, [path]: on ? undefined : a.id }))}>
                      <span className="pv-good mono">+{f.add}</span> <span className="pv-bad mono">−{f.del}</span> {on ? 'tomado' : 'tomar'}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pv-compose__foot">
        <span className="pv-muted">{chosen.length ? `${chosen.length} archivo${chosen.length === 1 ? '' : 's'} elegido${chosen.length === 1 ? '' : 's'} para «${task.title}»` : 'Nada elegido todavía'}</span>
        <span className="panelhead__fill" />
        <button type="button" className="btn btn--accent btn--sm" disabled={!chosen.length} onClick={start}><I n="split" size={12} />Arrancar Intento combinado</button>
      </div>
    </div>
  );
}

function Columns({ atts, render }) {
  return <div className="pv-cmp__cols" style={{ gridTemplateColumns: `repeat(${atts.length}, minmax(0, 1fr))` }}>{atts.map(render)}</div>;
}

export function PreviewCompare() {
  const s = usePreviewStore();
  const cur = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, cur);
  const atts = attemptsOfTask(s, task.id);
  const [msg, setMsg] = useState('');
  const [pane, setPane] = useState('diff');
  if (atts.length < 2) {
    return (
      <div className="pv-pad">
        <header className="pv-view__head"><h1 className="pv-view__title">Comparar Intentos</h1></header>
        <div className="changes__empty">
          «{task.title}» tiene un solo Intento.
          <button type="button" className="btn btn--accent btn--sm" onClick={() => s.openFork(cur.id)}>Nuevo Intento en paralelo</button>
          para probar otro agente con el mismo ContextPackage.
        </div>
      </div>
    );
  }
  const testsRatio = atts.map((a) => (a.tests ? a.tests.pass / a.tests.total : null));
  const rows = [
    ['Archivos', atts.map((a) => a.files), best(atts.map((a) => a.files), 'min'), (v) => `${v} archivos`],
    ['Líneas', atts.map((a) => <span key={a.id} className="mono"><b className="pv-good">+{a.add}</b> <b className="pv-bad">−{a.del}</b></span>)],
    ['Pruebas', testsRatio, best(testsRatio, 'max'), (v, a) => (a.tests ? `${a.tests.pass}/${a.tests.total}` : '—')],
    ['Tiempo', atts.map((a) => a.minutes), best(atts.map((a) => a.minutes), 'min'), (v) => `${v} min`],
    ['Uso', atts.map((a) => a.cost), best(atts.map((a) => a.cost), 'min'), (v, a) => `${money(v)} · ${kTokens(a.tokens)} tokens`],
    ['Avisos', atts.map((a) => WARN[a.id] ?? 0), best(atts.map((a) => WARN[a.id] ?? 0), 'min'), (v) => (v ? `${v} aviso${v > 1 ? 's' : ''}` : 'ninguno')],
    ['Riesgos', atts.map((a) => { const p = PROOF_PACKS[a.id]; return p ? <span key={a.id} className="pv-wrap">{p.risks.map((r, i) => <span key={i} className={`pv-risk pv-risk--${r.level}`}>{RISK_LABEL[r.level]}</span>)}</span> : <span key={a.id} className="pv-muted">sin evaluar</span>; })],
  ];
  const running = atts.some((a) => ['working', 'starting', 'waiting'].includes(a.state));
  return (
    <div className="pv-cmp">
      <header className="pv-view__head">
        <h1 className="pv-view__title">Comparar Intentos · {task.title}</h1>
        <span className="pv-tag pv-tone-done">Mismo ContextPackage {atts[0].ctx}</span>
        <span className="pv-muted">{running ? 'Comparación provisional · hay Intentos en marcha' : 'Compara la evidencia antes de elegir'}</span>
      </header>
      <section className="pv-cmp__top" aria-label="Resumen de la comparación">
        <div className="pv-cmp__grid" style={{ gridTemplateColumns: `112px repeat(${atts.length}, minmax(0, 1fr))` }}>
          <div />
          {atts.map((a) => (
            <div key={a.id} className={`pv-cmp__col${s.choice[task.id] === a.id ? ' is-chosen' : ''}`}>
              <div className="pv-wrap"><span className="pv-strip__l mono">{a.label}</span><Agent attempt={a} /><StatePill attempt={a} />{s.choice[task.id] === a.id && <span className="pv-tag pv-tone-done">elegido</span>}</div>
              <Loc attempt={a} parts={['branch', 'host']} forceHost />
              <button type="button" className="btn btn--accent btn--sm" onClick={() => s.choose(task.id, a.id)}>Elegir {a.label} · {agentName(a)}</button>
            </div>
          ))}
          {rows.map(([label, cells, bestIdx, fmt]) => (
            <div key={label} style={{ display: 'contents' }}>
              <div className="pv-cmp__label">{label}</div>
              {cells.map((c, i) => (
                <div key={atts[i].id} className={`pv-cmp__cell${bestIdx === i ? ' is-best' : ''}`}>
                  {fmt && c != null ? fmt(c, atts[i]) : c == null ? <span className="pv-muted">—</span> : c}
                  {bestIdx === i && <span className="pv-cmp__best" title="El mejor del conjunto">mejor</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className="pv-cmp__explore" aria-label="Explorar la comparación">
        <div className="pv-cmp__bar">
          <Tabs value={pane} onChange={setPane} label="Explorar" options={[{ id: 'diff', label: 'Diferencias' }, { id: 'compose', label: 'Componer' }, { id: 'risks', label: 'Riesgos' }, { id: 'evidence', label: 'Evidencia' }]} />
          <span className="panelhead__fill" />
          <label className="field pv-cmp__ask"><input placeholder="Una instrucción para todos…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Instrucción para todos los Intentos" /></label>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!msg.trim()} onClick={() => { atts.forEach((a) => s.send({ attemptId: a.id, text: msg })); setMsg(''); }}>Pedir a todos que revisen</button>
        </div>
        <div className="pv-cmp__pane scroll">
          {pane === 'diff' && (
            <Columns atts={atts} render={(a, i) => (
              <section key={a.id} className="pv-cmp__card">
                <h3>Intento {a.label} · enfoque</h3>
                <p>{APPROACH[a.id] || 'El resumen del enfoque llega cuando el Intento termine.'}</p>
                <ul className="pv-insp__files">{filesOf(s, a).map((f) => <li key={f.path}>{f.risk && <span className={`pv-riskdot pv-riskdot--${f.risk}`} />}<span className="mono pv-trunc">{f.path}</span><span className="pv-good mono">+{f.add}</span><span className="pv-bad mono">−{f.del}</span></li>)}</ul>
                {atts.length === 2 && i === 1 && <p className="pv-cmp__delta"><b>B frente a A:</b> {deltas(atts[0], atts[1]).join(' · ') || 'sin diferencia medible todavía'}</p>}
              </section>
            )} />
          )}
          {pane === 'compose' && <Compose atts={atts} s={s} task={task} />}
          {pane === 'risks' && (
            <Columns atts={atts} render={(a) => {
              const p = PROOF_PACKS[a.id];
              return (
                <section key={a.id} className="pv-cmp__card">
                  <h3>Intento {a.label} · riesgos</h3>
                  {p ? <ul className="pv-insp__list pv-insp__list--plain">{p.risks.map((r) => <li key={r.text}><span className={`pv-risk pv-risk--${r.level}`}>{RISK_LABEL[r.level]}</span> {r.text}</li>)}</ul> : <p className="pv-muted">Sin evaluar: los riesgos se evalúan cuando el Intento termina.</p>}
                </section>
              );
            }} />
          )}
          {pane === 'evidence' && (
            <Columns atts={atts} render={(a) => {
              const p = PROOF_PACKS[a.id];
              const notPassed = p ? p.validation.filter((v) => v.status !== 'pass') : [];
              return (
                <section key={a.id} className="pv-cmp__card">
                  <h3>Intento {a.label} · evidencia</h3>
                  {p ? (
                    <>
                      <p>{p.validation.length - notPassed.length} de {p.validation.length} comprobaciones pasaron{notPassed.length > 0 && <> · <b className="pv-bad">{notPassed.length} no pasaron</b></>}</p>
                      {p.failed.map((f) => <p key={f} className="pv-flag pv-tone-failed"><b>Falló</b> {f}</p>)}
                      {p.unverified.map((f) => <p key={f} className="pv-flag pv-tone-waiting"><b>Sin verificar</b> {f}</p>)}
                    </>
                  ) : <p className="pv-muted">La evidencia se reúne cuando el Intento termina.</p>}
                  <div className="pv-wrap">
                    <button type="button" className="btn btn--accent btn--sm" disabled={!p} onClick={() => s.select(a.id, 'proof')}><I n="eye" size={12} />Proof Pack</button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.select(a.id, 'review')}>Abrir el diff</button>
                  </div>
                </section>
              );
            }} />
          )}
        </div>
        <p className="pv-muted pv-cmp__note">«Elegir» registra el ganador y ofrece archivar el resto. No se borra ni se integra nada hasta la integración.</p>
      </section>
    </div>
  );
}
