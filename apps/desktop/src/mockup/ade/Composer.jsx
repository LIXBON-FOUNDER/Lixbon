// Composer.jsx — el compositor es un CONTROL DE EJECUCIÓN, no un textbox.
// Antes de enviar se ve: destino (Task/Attempt/host/branch/policy), qué hará Enter, y qué ocurre con lo ya ejecutado.
// Con un Attempt ocupado, Enter = Queue (decisión D1; configurable y explícita, nunca un default oculto del proveedor).
import { useState, useRef } from 'react';
import { useStore, attemptById, taskOf } from '../store';
import { MODES, isBusy, provider, agentShort, hostOf } from '../vocab';
import { I, Kbd, Loc } from '../ui';
import { PROVIDERS } from '../data';

const ATTACH = [
  ['file', 'File…'], ['folder', 'Folder…'], ['code', 'Selected code'], ['diff', 'Diff'], ['image', 'Screenshot'], ['terminal', 'Terminal output'],
  ['pr', 'Issue / PR'], ['book', 'Artifact'], ['history', 'Prior Attempt'], ['db', 'ContextPackage preview'],
];

export function PendingDock({ attemptId, compact }) {
  const s = useStore();
  const list = s.pending[attemptId] || [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const a = attemptById(s, attemptId);
  if (!list.length) return null;
  return (
    <div className="dock" aria-label="Pending instructions">
      <button type="button" className="dock__h" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <I n={open ? 'down' : 'right'} size={11} /> PENDING <b>{list.length}</b>
        <span className="muted"> · sent in order after the current turn</span>
        <span className="sp" />
        {!open && <span className="muted dock__hint">Next: {list[0].text}</span>}
      </button>
      {open && (
        <ol className="dock__list">
          {list.map((p, i) => (
            <li key={p.id} className={`dock__i ${i === 0 ? 'is-next' : ''}`}>
              <span className="dock__n">{i + 1}</span>
              <button type="button" className={`chip chip--tag dock__mode dock__mode--${p.mode}`} onClick={() => s.convertPending(attemptId, p.id)} title={p.mode === 'queue' ? 'Convert to Steer' : 'Convert to Queue'}>{p.mode}{p.applying && <span className="dock__spin" />}</button>
              {editing === p.id ? (
                <input className="input grow" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { s.editPending(attemptId, p.id, draft); setEditing(null); } if (e.key === 'Escape') setEditing(null); }} onBlur={() => setEditing(null)} />
              ) : (
                <span className="dock__t grow" title={p.text}>{p.text}</span>
              )}
              {p.from !== 'ADE' && <span className="chip chip--tag chip--dim" title={`Sent from ${p.from}`}>{p.from}</span>}
              {p.applying && <span className="muted dock__ap">applies at next safe boundary…</span>}
              {p.note && <span className="muted dock__ap">{p.note}</span>}
              {!compact && (
                <span className="dock__acts">
                  <button type="button" className="btn btn--text btn--icon" aria-label="Move up" disabled={i === 0} onClick={() => s.movePending(attemptId, p.id, -1)}><I n="upchev" size={12} /></button>
                  <button type="button" className="btn btn--text btn--icon" aria-label="Move down" disabled={i === list.length - 1} onClick={() => s.movePending(attemptId, p.id, 1)}><I n="down" size={12} /></button>
                  <button type="button" className="btn btn--text btn--icon" aria-label="Edit" onClick={() => { setEditing(p.id); setDraft(p.text); }}><I n="pencil" size={12} /></button>
                  <button type="button" className="btn btn--text btn--icon" aria-label="Turn into a parallel Attempt" title="→ new Attempt (Fork)" onClick={() => s.pendingToAttempt(attemptId, p.id)}><I n="split" size={12} /></button>
                  <button type="button" className="btn btn--text btn--icon" aria-label="Delete" onClick={() => s.removePending(attemptId, p.id)}><I n="x" size={12} /></button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {open && (
        <div className="dock__f">
          <span className="muted">Next: “{list[0].text.slice(0, 48)}{list[0].text.length > 48 ? '…' : ''}”</span>
          <span className="sp" />
          {isBusy(a) && <button type="button" className="btn btn--text btn--sm" onClick={() => s.endTurn(attemptId)} title="Simulation control — not part of the product"><span className="dbadge">sim</span> End current turn</button>}
        </div>
      )}
    </div>
  );
}

export default function Composer({ attemptId, compact = false, from = 'ADE' }) {
  const s = useStore();
  const a = attemptById(s, attemptId);
  const task = a && taskOf(s, a);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [plus, setPlus] = useState(false);
  const [att, setAtt] = useState([]);
  const ta = useRef(null);
  if (!a) return null;
  const busy = isBusy(a);
  const offline = a.state === 'offline';
  const mode = busy ? s.composerMode[a.id] || s.prefs.followUp : 'send';
  const canSteer = PROVIDERS[a.provider].steer;
  const M = MODES[mode];
  const queued = (s.pending[a.id] || []).length;

  function go(m) {
    const msg = text.trim();
    if (!msg) return;
    if (busy && m === 'stop') { s.setOverlay({ type: 'confirmstop', attemptId: a.id, text: msg, from }); return; }
    if (busy && m === 'fork') { s.openFork(a.id, msg); setText(''); setAtt([]); return; }
    s.send({ attemptId: a.id, text: msg, mode: busy ? m : undefined, from });
    setText(''); setAtt([]); if (ta.current) ta.current.style.height = 'auto';
  }
  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) go(e.shiftKey ? 'stop' : 'steer');
      else go(mode === 'send' ? 'send' : mode);
    } else if (e.key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go('stop'); }
    else if (e.key === 'Escape') { setText(''); setMenu(false); }
  }

  const hint = !busy
    ? (offline ? `${hostOf(a.host).name} is offline — your message is saved and delivered on reconnect.` : 'Enter sends a new turn to this Attempt.')
    : mode === 'queue' ? `Enter adds this after the current turn${queued ? ` (position ${queued + 1})` : ''}. Nothing is interrupted.`
    : mode === 'steer' ? 'Applies at the next safe boundary of the running turn. Nothing is stopped.'
    : mode === 'stop' ? 'Stops the running turn first. Tools already run and files written are NOT reverted.'
    : 'Keeps this Attempt running and starts a parallel one in its own worktree.';

  return (
    <div className={`cmp ${compact ? 'cmp--compact' : ''} ${busy ? 'is-busy' : ''}`}>
      <PendingDock attemptId={a.id} compact={compact} />
      <div className="cmp__box">
        {att.length > 0 && (
          <div className="cmp__att">
            {att.map((x) => <span key={x} className="chip chip--dim">{x}<button type="button" aria-label={`Remove ${x}`} onClick={() => setAtt(att.filter((y) => y !== x))}><I n="x" size={10} /></button></span>)}
            <span className="muted">referenced {att.length} · materialized {att.length} (secrets redacted)</span>
          </div>
        )}
        <textarea ref={ta} className="cmp__ta" rows={1} value={text} onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`; }} onKeyDown={onKey}
          placeholder={busy ? 'Add an instruction for after this turn…   (Shift+Enter for a new line)' : 'Message the agent…'} aria-label="Instruction" />
        <div className="cmp__bar">
          <div className="cmp__plus">
            <button type="button" className="btn btn--text btn--icon" onClick={() => setPlus((v) => !v)} aria-label="Attach context" title="Attach context"><I n="plus" size={14} /></button>
            {plus && (
              <div className="menu cmp__menu" style={{ bottom: 32, left: 0 }} role="menu" onMouseLeave={() => setPlus(false)}>
                <div className="menu__h">Attach context</div>
                {ATTACH.map(([ic, label]) => <button key={label} type="button" className="menu__i" role="menuitem" onClick={() => { setAtt((x) => (x.includes(label) ? x : [...x, label])); setPlus(false); }}><I n={ic} size={13} />{label}</button>)}
              </div>
            )}
          </div>
          <div className="cmp__target" aria-label="Message target" title={`${task.title} · Attempt ${a.label} · ${agentShort(a)} · ${a.policy}`}>
            <span className="chip chip--tag chip--accent">to</span>
            <span className="chip mono">Attempt {a.label}</span>
            <span className="chip">{agentShort(a)}</span>
            <span className="chip chip--dim"><I n="shield" size={12} />{a.policy}</span>
          </div>
          <span className={`cmp__hint ${mode === 'stop' ? 'warn' : ''}`} title={hint}>{hint}</span>
          <span className="sp" />
          {busy ? (
            <div className="cmp__mode">
              <button type="button" className={`cmp__modebtn cmp__modebtn--${mode}`} onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
                <b>{M.label}</b><span>{M.sub}</span><I n="down" size={11} />
              </button>
              {menu && (
                <div className="menu cmp__menu cmp__menu--modes" style={{ bottom: 36, right: 0 }} role="menu" onMouseLeave={() => setMenu(false)}>
                  {['queue', 'steer', 'stop'].map((id) => {
                    const dis = id === 'steer' && !canSteer;
                    return (
                      <button key={id} type="button" role="menuitemradio" aria-checked={mode === id} className={`menu__i ${mode === id ? 'is-hot' : ''} ${dis ? 'is-off' : ''}`}
                        onClick={() => { if (dis) { s.toast(`${PROVIDERS[a.provider].name} can’t Steer natively — Lixbon won’t pretend. It would degrade to Queue.`, 'warn'); return; } s.setComposerMode(a.id, id); setMenu(false); }}>
                        <span><b>{MODES[id].label}</b> <small>{dis ? `${PROVIDERS[a.provider].name} has no native Steer → degrades to Queue (explicit)` : MODES[id].desc}</small></span>
                        <Kbd>{MODES[id].keys}</Kbd>
                      </button>
                    );
                  })}
                  <div className="menu__sep" />
                  <button type="button" className="menu__i" role="menuitem" onClick={() => { setMenu(false); s.setComposerMode(a.id, 'fork'); }}><span><b>Fork as new Attempt…</b><small>{MODES.fork.desc}</small></span></button>
                  <button type="button" className="menu__i" role="menuitem" onClick={() => { setMenu(false); s.toast('Delegate to… (simulated): hand the instruction to another agent.'); }}><span><b>Delegate to…</b><small>Hand this to a different agent/host</small></span></button>
                  <div className="menu__sep" />
                  <label className="menu__i" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={s.prefs.followUp === 'steer'} onChange={(e) => s.setPref({ followUp: e.target.checked ? 'steer' : 'queue' })} />
                    <span><b>Follow-up default: {s.prefs.followUp === 'queue' ? 'Queue' : 'Steer'}</b><small>Check to make Steer the Enter default (D1)</small></span>
                  </label>
                </div>
              )}
            </div>
          ) : (
            <span className="muted cmp__idle">Idle</span>
          )}
          <button type="button" className={`btn ${busy && mode === 'stop' ? 'btn--danger' : 'btn--accent'} btn--icon cmp__send`} onClick={() => go(busy ? mode : 'send')} disabled={!text.trim()} aria-label={busy ? `${M.label}` : 'Send'} title={busy ? M.label : 'Send'}>
            <I n="up" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

