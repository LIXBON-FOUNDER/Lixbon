// PreviewComposer.jsx — el compositor es un control de ejecución, no un cuadro de texto.
// Antes de enviar se ve el destino (Intento, agente, perfil), qué hará Enter y qué pasa con lo ya ejecutado.
// Con el Intento ocupado, Enter = En cola; Ctrl Enter = Corregir; Ctrl Shift Enter = Detener y enviar.
import { useRef, useState } from 'react';
import { Popover } from '../../components/Popover';
import { usePreviewStore, attemptById } from './previewStore';
import { MODES, isBusy, agentName, canSteer, hostOf, policyName, attemptName } from './previewVocab';
import { I, SimBadge } from './PreviewUi';

const ATTACH = ['Archivo…', 'Carpeta…', 'Código seleccionado', 'Diff', 'Captura', 'Salida de la terminal', 'Issue o PR', 'Intento anterior'];

function PendingDock({ attemptId }) {
  const s = usePreviewStore();
  const list = s.pending[attemptId] || [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const a = attemptById(s, attemptId);
  if (!list.length) return null;
  return (
    <div className="pv-dock" aria-label="Instrucciones pendientes">
      <button type="button" className="pv-dock__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <I n={open ? 'down' : 'right'} size={11} />
        <b>Pendientes</b><span className="count">{list.length}</span>
        <span className="pv-muted">se envían en orden al acabar el turno</span>
        <span className="panelhead__fill" />
        {!open && <span className="pv-muted pv-dock__next">Siguiente: {list[0].text}</span>}
      </button>
      {open && (
        <ol className="pv-dock__list">
          {list.map((p, i) => (
            <li key={p.id} className={`pv-dock__item${i === 0 ? ' is-next' : ''}`}>
              <span className="pv-dock__n mono">{i + 1}</span>
              <button type="button" className={`pv-tag pv-dock__mode pv-dock__mode--${p.mode}`} onClick={() => s.convertPending(attemptId, p.id)} title={p.mode === 'queue' ? 'Pasar a Corregir' : 'Pasar a la cola'}>
                {MODES[p.mode]?.label || p.mode}
              </button>
              {editing === p.id ? (
                <input
                  className="pv-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { s.editPending(attemptId, p.id, draft); setEditing(null); } if (e.key === 'Escape') setEditing(null); }}
                  onBlur={() => setEditing(null)}
                  aria-label="Editar instrucción"
                />
              ) : <span className="pv-dock__text" title={p.text}>{p.text}</span>}
              {p.from !== 'ADE' && <span className="pv-tag pv-tag--dim" title={`Enviada desde ${p.from}`}>{p.from}</span>}
              {p.applying && <span className="pv-muted">se aplica en el próximo punto seguro…</span>}
              {p.note && <span className="pv-muted">{p.note}</span>}
              <span className="pv-dock__acts">
                <button type="button" className="ic" aria-label="Subir" disabled={i === 0} onClick={() => s.movePending(attemptId, p.id, -1)}><I n="up" size={12} /></button>
                <button type="button" className="ic" aria-label="Bajar" disabled={i === list.length - 1} onClick={() => s.movePending(attemptId, p.id, 1)}><I n="down" size={12} /></button>
                <button type="button" className="ic" aria-label="Editar" onClick={() => { setEditing(p.id); setDraft(p.text); }}><I n="pencil" size={12} /></button>
                <button type="button" className="ic" aria-label="Convertir en un Intento en paralelo" title="Nuevo Intento en paralelo" onClick={() => s.pendingToAttempt(attemptId, p.id)}><I n="split" size={12} /></button>
                <button type="button" className="ic" aria-label="Quitar" onClick={() => s.removePending(attemptId, p.id)}><I n="x" size={12} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {open && isBusy(a) && (
        <div className="pv-dock__foot">
          <span className="panelhead__fill" />
          <button type="button" className="lk" onClick={() => s.endTurn(attemptId)}><SimBadge /> Terminar el turno actual</button>
        </div>
      )}
    </div>
  );
}

export function PreviewComposer({ attemptId, from = 'ADE' }) {
  const s = usePreviewStore();
  const a = attemptById(s, attemptId);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [plus, setPlus] = useState(false);
  const [att, setAtt] = useState([]);
  const ta = useRef(null);
  const modeRef = useRef(null);
  const plusRef = useRef(null);
  if (!a) return null;
  const busy = isBusy(a);
  const offline = a.state === 'offline';
  const mode = busy ? s.composerMode[a.id] || s.prefs.followUp : 'send';
  const steer = canSteer(a);
  const M = MODES[mode];
  const queued = (s.pending[a.id] || []).length;

  const go = (m) => {
    const msg = text.trim();
    if (!msg) return;
    if (busy && m === 'stop') { s.setOverlay({ type: 'confirmstop', attemptId: a.id, text: msg, from }); return; }
    if (busy && m === 'fork') { s.openFork(a.id, msg); setText(''); setAtt([]); return; }
    s.send({ attemptId: a.id, text: msg, mode: busy ? m : undefined, from });
    setText(''); setAtt([]);
    if (ta.current) ta.current.style.height = 'auto';
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) go('steer');
      else go(mode === 'send' ? 'send' : mode);
    } else if (e.key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go('stop'); }
  };
  const hint = !busy
    ? (offline ? `${hostOf(a.host).name} está desconectado: tu mensaje se guarda y se entrega al volver.` : 'Enter envía un turno nuevo a este Intento.')
    : mode === 'queue' ? `Enter lo añade tras el turno actual${queued ? ` (posición ${queued + 1})` : ''}. No se interrumpe nada.`
      : mode === 'steer' ? 'Se aplica en el próximo punto seguro del turno en marcha. No se detiene nada.'
        : mode === 'stop' ? 'Detiene primero el turno. Lo ya ejecutado y escrito NO se deshace.'
          : 'Este Intento sigue y arranca otro en paralelo, con su propio worktree.';

  return (
    <div className={`pv-composer${busy ? ' is-busy' : ''}`}>
      <PendingDock attemptId={a.id} />
      <div className="pv-composer__box">
        {att.length > 0 && (
          <div className="pv-composer__att">
            {att.map((x) => <span key={x} className="pv-tag">{x}<button type="button" className="ic" aria-label={`Quitar ${x}`} onClick={() => setAtt(att.filter((y) => y !== x))}><I n="x" size={10} /></button></span>)}
          </div>
        )}
        <textarea
          ref={ta}
          className="pv-composer__input"
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`; }}
          onKeyDown={onKey}
          placeholder={busy ? 'Añade una instrucción para después de este turno… (Shift Enter: nueva línea)' : 'Escribe al agente…'}
          aria-label="Instrucción"
        />
        <div className="pv-composer__bar">
          <button ref={plusRef} type="button" className="ic" onClick={() => setPlus((v) => !v)} aria-label="Adjuntar contexto" title="Adjuntar contexto"><I n="plus" size={14} /></button>
          <Popover anchorRef={plusRef} open={plus} onClose={() => setPlus(false)} below={false}>
            <div className="menu" role="menu">
              <div className="menu__label">Adjuntar contexto</div>
              {ATTACH.map((label) => (
                <button key={label} type="button" className="menu__item" role="menuitem" onClick={() => { setAtt((x) => (x.includes(label) ? x : [...x, label])); setPlus(false); }}>
                  <span className="menu__main">{label}</span>
                </button>
              ))}
            </div>
          </Popover>
          <span className="pv-composer__target" title={`${attemptName(a)} · ${agentName(a)} · ${policyName(a.policy)}`}>
            <span className="pv-muted">a</span><b>{attemptName(a)}</b><span className="pv-muted">·</span><span>{agentName(a)}</span><span className="pv-muted">·</span><span><I n="shield" size={11} /> {policyName(a.policy)}</span>
          </span>
          <span className={`pv-composer__hint${mode === 'stop' ? ' pv-tone-failed' : ''}`} title={hint}>{hint}</span>
          <span className="panelhead__fill" />
          {busy ? (
            <>
              <button ref={modeRef} type="button" className={`pv-composer__mode pv-composer__mode--${mode}`} onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
                <b>{M.label}</b><span>{M.sub}</span><I n="down" size={11} />
              </button>
              <Popover anchorRef={modeRef} open={menu} onClose={() => setMenu(false)} align="right" below={false}>
                <div className="menu pv-modes" role="menu">
                  {['queue', 'steer', 'stop'].map((id) => {
                    const off = id === 'steer' && !steer;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={mode === id}
                        className={`menu__item pv-menu__item${mode === id ? ' is-current' : ''}`}
                        onClick={() => {
                          if (off) { s.toast(`${agentName(a)} no puede corregir un turno en marcha: Lixbon no lo finge e iría a la cola.`); return; }
                          s.setComposerMode(a.id, id); setMenu(false);
                        }}
                      >
                        <span className="pv-menu__main">{MODES[id].label} <kbd>{MODES[id].keys}</kbd></span>
                        <span className="pv-menu__hint">{off ? `${agentName(a)} no puede corregir en marcha: iría a la cola` : MODES[id].desc}</span>
                      </button>
                    );
                  })}
                  <div className="menu__sep" />
                  <button type="button" className="menu__item pv-menu__item" role="menuitem" onClick={() => { setMenu(false); s.setComposerMode(a.id, 'fork'); }}>
                    <span className="pv-menu__main">{MODES.fork.label}…</span><span className="pv-menu__hint">{MODES.fork.desc}</span>
                  </button>
                  <div className="menu__sep" />
                  <label className="menu__item pv-menu__item">
                    <span className="pv-menu__main"><input type="checkbox" checked={s.prefs.followUp === 'steer'} onChange={(e) => s.setPref({ followUp: e.target.checked ? 'steer' : 'queue' })} /> Enter corrige en vez de ir a la cola</span>
                    <span className="pv-menu__hint">Por defecto, una instrucción con el agente ocupado va a la cola.</span>
                  </label>
                </div>
              </Popover>
            </>
          ) : <span className="pv-muted">En reposo</span>}
          <button
            type="button"
            className={`btn btn--sm ${busy && mode === 'stop' ? 'pv-btn--danger' : 'btn--accent'} pv-composer__send`}
            onClick={() => go(busy ? mode : 'send')}
            disabled={!text.trim()}
            aria-label={busy ? M.label : 'Enviar'}
            title={busy ? M.label : 'Enviar'}
          >
            <I n="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
