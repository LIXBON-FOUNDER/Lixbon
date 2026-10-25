// OrchDialogs.jsx — Integrar, Revisar diff, Detener y Nuevo run. Todo lo que cambia el mundo pasa por una confirmación explícita.
import React, { useEffect, useRef, useState } from 'react';
import { useOrch, reviewStatus } from './orchStore';
import { PROJECT, ROLES, PROVIDERS } from './orchData';
import { AgentChip, PlanTag, roleName, I } from './orchUi';

function Modal({ title, onClose, wide, children, labelId }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('button, input, textarea')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="o-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`o-modal ${wide ? 'o-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref}>
        <header className="o-modal__h"><h2 id={labelId}>{title}</h2><button type="button" className="o-ico" aria-label="Cerrar" onClick={onClose}><I n="x" size={13} /></button></header>
        {children}
      </div>
    </div>
  );
}

function Integrate({ t }) {
  const s = useOrch();
  const close = s.closeDialog;
  const [target, setTarget] = useState(PROJECT.coordBranch);
  const [ok, setOk] = useState(false);
  const lr = s.lastReview[t.id];
  return (
    <Modal title="Integrar esta rama" onClose={close} labelId="o-int-t">
      <div className="o-modal__b">
        <p className="o-kv"><span>Rama</span><b className="mono">{t.branch}</b></p>
        <p className="o-kv"><span>Destino</span>
          <span className="o-select"><select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Rama de destino">
            <option value={PROJECT.coordBranch}>{PROJECT.coordBranch} (rama del coordinador)</option><option value="master">master</option></select><I n="down" size={11} /></span>
        </p>
        <ul className="o-checks">
          <li className="is-ok">Revisada y aceptada sobre <span className="mono">{lr?.head}</span>, el HEAD actual</li>
          <li className="is-ok">{t.tests ? `${t.tests.pass}/${t.tests.total} pruebas pasando` : 'Sin pruebas declaradas'}</li>
          <li className="is-ok">Sin conflictos previstos con el destino</li>
          <li className="is-ok">El destino sigue donde lo dejó el coordinador</li>
        </ul>
        <p className="o-meta">Si hay conflictos al fusionar, la integración se aborta sin cambiar nada y queda registrada. El coordinador no puede integrar: <span className="mono">lxo merge</span> se rechaza.</p>
        <label className="o-check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Confirmo integrar {t.files.length} archivos en <span className="mono">{target}</span></label>
      </div>
      <footer className="o-modal__f"><button type="button" className="btn btn--ghost" onClick={close}>Cancelar</button><button type="button" className="btn btn--accent" disabled={!ok} onClick={() => s.integrate(t.id, target)}>Integrar</button></footer>
    </Modal>
  );
}

function Review({ t }) {
  const s = useOrch();
  const [i, setI] = useState(0);
  const f = t.diff?.[i];
  const rv = reviewStatus(s, t);
  return (
    <Modal title={`Revisar · ${t.title}`} onClose={s.closeDialog} wide labelId="o-rv-t">
      <div className="o-review">
        <ul className="o-review__files" aria-label="Archivos cambiados">
          {(t.diff || []).map((d, k) => (
            <li key={d.path}><button type="button" className={k === i ? 'is-sel' : ''} onClick={() => setI(k)}><span className="mono">{d.path.split('/').pop()}</span><span className="o-meta">+{d.add} −{d.del}</span></button></li>
          ))}
        </ul>
        <div className="o-review__diff">
          {f && <p className="o-meta mono">{f.path}</p>}
          {f && <pre className="o-diff mono">{f.hunk.map(([k, line], n) => <span key={n} className={`o-diff__${k === '+' ? 'add' : k === '-' ? 'del' : 'ctx'}`}>{k}{' '}{line}{'\n'}</span>)}</pre>}
        </div>
      </div>
      <footer className="o-modal__f o-modal__f--split">
        <span className="o-meta">Tu decisión vale solo para el HEAD <span className="mono">{t.head}</span>{rv === 'stale' ? ' · la rama cambió tras tu revisión anterior' : ''}. Si la rama recibe otro commit, hay que revisarla de nuevo.</span>
        <span className="o-actions">
          <button type="button" className="btn btn--ghost" onClick={() => { s.review(t.id, 'rejected'); s.closeDialog(); }}>Rechazar</button>
          <button type="button" className="btn btn--accent" onClick={() => { s.review(t.id, 'accepted'); s.closeDialog(); }}>Aceptar este diff</button>
        </span>
      </footer>
    </Modal>
  );
}

function Stop({ t }) {
  const s = useOrch();
  return (
    <Modal title="¿Detener esta tarea?" onClose={s.closeDialog} labelId="o-st-t">
      <div className="o-modal__b">
        <p>Se cierra la terminal de <b>{t.title}</b>. La rama y el worktree se conservan; lo que no tenga commit no se borra.</p>
        <p className="o-meta">Solo para emergencias: el coordinador recibe el aviso y decide si la relanza como un intento nuevo.</p>
      </div>
      <footer className="o-modal__f"><button type="button" className="btn btn--ghost" onClick={s.closeDialog}>Seguir</button><button type="button" className="btn btn--danger" onClick={() => s.stop(t.id)}>Detener tarea</button></footer>
    </Modal>
  );
}

const MODES = [
  { id: 'coord', label: 'Coordinar por roles', note: 'Un coordinador reparte el objetivo entre exploradores, implementadores, revisores y adversarios. Cada lanzamiento lo apruebas tú.' },
  { id: 'compare', label: 'Comparar agentes', note: 'El mismo encargo a varios agentes en worktrees distintos; comparas los diffs y fusionas el ganador.', plan: 'Fase 5' },
  { id: 'handoff', label: 'Handoff sin supervisión', note: 'Un agente en otro worktree, sin run ni espera. Lo ves después en Flota.', plan: 'Fase 5' },
];
function NewRun() {
  const s = useOrch();
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState('coord');
  return (
    <Modal title="Nuevo run" onClose={s.closeDialog} labelId="o-nr-t">
      <div className="o-modal__b">
        <label className="o-field o-field--col"><span>Objetivo, en una frase (equivale a <span className="mono">/orquestar</span>)</span>
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Ej. Que el ADE avise cuando el arranque active el corte Task/Attempt (LXB-52)" />
        </label>
        <fieldset className="o-modes"><legend className="o-meta">Cómo trabajar</legend>
          {MODES.map((m) => (
            <label key={m.id} className={mode === m.id ? 'is-on' : ''}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span><b>{m.label}</b>{m.plan && <> <PlanTag phase={m.plan} /></>}<span className="o-meta">{m.note}</span></span>
            </label>
          ))}
        </fieldset>
        {mode === 'coord' && (
          <ul className="o-team-prev" aria-label="Equipo configurado">
            {Object.entries(s.roles).map(([r, c]) => <li key={r}><span>{roleName(r)}</span><AgentChip agent={c.agent} model={c.model} effort={c.effort} size={13} /></li>)}
          </ul>
        )}
      </div>
      <footer className="o-modal__f"><button type="button" className="btn btn--ghost" onClick={s.closeDialog}>Cancelar</button><button type="button" className="btn btn--primary" disabled={!objective.trim()} onClick={() => s.newRun({ objective, mode })}>{mode === 'coord' ? 'Crear run' : mode === 'compare' ? 'Lanzar comparación' : 'Lanzar handoff'}</button></footer>
    </Modal>
  );
}

export function OrchDialogs() {
  const s = useOrch();
  const d = s.dialog;
  if (!d) return null;
  const t = d.taskId && s.tasks.find((x) => x.id === d.taskId);
  if (d.kind === 'newrun') return <NewRun />;
  if (!t) return null;
  if (d.kind === 'integrate') return <Integrate t={t} />;
  if (d.kind === 'review') return <Review t={t} />;
  if (d.kind === 'stop') return <Stop t={t} />;
  return null;
}

export function Toasts() {
  const toasts = useOrch((s) => s.toasts);
  return (
    <div className="o-toasts" role="status" aria-live="polite">
      {toasts.map((x) => <div key={x.id} className={`o-toast o-toast--${x.tone}`}>{x.text}</div>)}
    </div>
  );
}

const SIM = [
  ['t2-done', 'Navegación F2 entrega su informe'],
  ['t3-done', 'Aviso de corte termina y desbloquea la revisión'],
  ['expire', 'Vence un lanzamiento pendiente'],
  ['reset', 'Restablecer la maqueta'],
];
export function SimMenu() {
  const s = useOrch();
  const [open, setOpen] = useState(false);
  return (
    <span className="o-sim">
      <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}><I n="sliders" size={12} /> Simular run</button>
      {open && (
        <ul className="o-menu" role="menu">
          {SIM.map(([k, l]) => <li key={k} role="none"><button type="button" role="menuitem" onClick={() => { s.simulate(k); setOpen(false); }}>{l}</button></li>)}
          <li className="o-menu__note" role="none">Controles de la maqueta, no del producto.</li>
        </ul>
      )}
    </span>
  );
}
