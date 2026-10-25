// PreviewSidebar.jsx — navegación Project → Task → Intento (worktree + agente) de la vista previa.
//  · 1 Intento  → la Task es una sola fila.  N Intentos → la Task es un grupo.
//  · Estado (forma) y Attention (marcador ámbar) son ejes distintos; «sin leer» es un tercero (punto).
//  · Orden estable: un cambio de estado nunca reordena filas.
//  · El marcador de Attention va en la fila hoja; en el padre solo si está plegado. Una cifra, un sitio.
import { useMemo, useRef, useState } from 'react';
import { Popover } from '../../components/Popover';
import { providerName } from '../../orch/agent/agentIdentity';
import { usePreviewStore, attemptsOfTask } from './previewStore';
import { PROJECTS } from './previewData';
import { Mark, AttnFlag, Agent, I } from './PreviewUi';
import { stateLabel, agentName, isRemote, hostOf, meta, attemptName } from './previewVocab';

const CHIPS = [
  { id: 'attention', label: 'Espera tu decisión' },
  { id: 'review', label: 'Listo para revisar' },
  { id: 'active', label: 'En ejecución' },
  { id: 'failed', label: 'Falló' },
];

function matches(s, a, t, p) {
  const { q, chips, hostId } = s.filter;
  const hay = `${p.name} ${t.title} ${a.branch || ''} ${agentName(a)} ${hostOf(a.host).name}`.toLowerCase();
  if (q && !hay.includes(q.toLowerCase())) return false;
  if (hostId && a.host !== hostId) return false;
  if (!chips.length) return true;
  return chips.some((c) => (c === 'attention' ? s.attention.some((x) => x.attemptId === a.id)
    : c === 'review' ? a.state === 'review_ready'
      : c === 'active' ? ['working', 'starting'].includes(a.state)
        : a.state === 'failed'));
}

function AttemptRow({ a, task, single, selected }) {
  const s = usePreviewStore();
  const attn = s.attention.filter((x) => x.attemptId === a.id);
  const m = meta(a);
  return (
    <button
      type="button"
      className={`pv-row ${single ? 'pv-row--task' : 'pv-row--att'}${selected ? ' is-sel' : ''}`}
      onClick={() => s.select(a.id)}
      aria-current={selected ? 'true' : undefined}
      title={`${task.title} · ${attemptName(a)}\n${stateLabel(a)}\n${a.branch || 'sin worktree'} · ${hostOf(a.host).name}`}
      data-attempt-id={a.id}
    >
      <span className="pv-row__lead"><Mark attempt={a} size={14} /></span>
      <span className="pv-row__main">
        <span className="pv-row__l1">
          {a.unread && <i className="pv-unread" title="Actividad sin leer" />}
          <span className={`pv-row__title${a.unread ? ' is-unread' : ''}`}>{single ? task.title : <Agent attempt={a} detail={false} />}</span>
          {attn.length > 0 && <AttnFlag n={attn.length} risk={attn.some((x) => x.risk === 'high') ? 'high' : undefined} />}
        </span>
        <span className="pv-row__l2">
          <span className={`pv-tone-${m.tone} pv-row__state`}>{stateLabel(a)}</span>
          {single && <><span className="pv-sep">·</span><span>{providerName(a.provider)}</span></>}
          {a.state === 'working' && a.minutes > 0 && <><span className="pv-sep">·</span><span>{a.minutes} min</span></>}
          {a.origin !== 'ADE' && <><span className="pv-sep">·</span><span title={`Empezó desde ${a.origin}`}>{a.origin}</span></>}
          {(isRemote(a) || a.state === 'offline') && <><span className="pv-sep">·</span><span>{hostOf(a.host).name}</span></>}
        </span>
      </span>
    </button>
  );
}

function TaskBlock({ task, project }) {
  const s = usePreviewStore();
  const [showAll, setShowAll] = useState(false);
  const all = attemptsOfTask(s, task.id);
  const atts = all.filter((a) => matches(s, a, task, project));
  if (!atts.length) return null;
  const selAtt = s.sel.attemptId;
  if (all.length === 1) return <AttemptRow a={all[0]} task={task} single selected={selAtt === all[0].id} />;

  const open = s.expanded[task.id] !== false;
  const attnTotal = all.reduce((n, a) => n + s.attention.filter((x) => x.attemptId === a.id).length, 0);
  const visible = showAll ? atts : atts.slice(0, 3);
  const hasSel = all.some((a) => a.id === selAtt);
  return (
    <div className="pv-group">
      <button type="button" className={`pv-grouphead${hasSel && !open ? ' is-sel' : ''}`} onClick={() => s.toggleExpanded(task.id)} aria-expanded={open}>
        <I n={open ? 'down' : 'right'} size={12} />
        <span className="pv-row__title">{task.title}</span>
        <span className="count" title={`${all.length} Intentos`}>{all.length}</span>
        <span className="panelhead__fill" />
        {!open && attnTotal > 0 && <AttnFlag n={attnTotal} />}
        {!open && all.map((a) => <Mark key={a.id} attempt={a} size={11} />)}
      </button>
      {open && (
        <div className="pv-children">
          {visible.map((a) => <AttemptRow key={a.id} a={a} task={task} selected={selAtt === a.id} />)}
          {atts.length > 3 && !showAll && <button type="button" className="lk pv-more" onClick={() => setShowAll(true)}>+{atts.length - 3} Intentos</button>}
        </div>
      )}
    </div>
  );
}

function NewMenu() {
  const s = usePreviewStore();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const pick = (fn) => () => { setOpen(false); fn(); };
  return (
    <>
      <button ref={ref} type="button" className="ic" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Nuevo" title="Nueva Task o Intento">
        <I n="plus" size={15} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="right">
        <div className="menu" role="menu">
          <button type="button" className="menu__item pv-menu__item" role="menuitem" onClick={pick(() => s.setOverlay({ type: 'newtask' }))}>
            <span className="pv-menu__main">Nueva Task…</span><span className="pv-menu__hint">Un objetivo durable. Arranca su primer Intento.</span>
          </button>
          <button type="button" className="menu__item pv-menu__item" role="menuitem" onClick={pick(() => s.openFork(s.sel.attemptId))}>
            <span className="pv-menu__main">Nuevo Intento de esta Task…</span><span className="pv-menu__hint">Otra ejecución del mismo objetivo.</span>
          </button>
          <div className="menu__sep" />
          <button type="button" className="menu__item pv-menu__item" role="menuitem" onClick={pick(() => s.toast('Adoptar un worktree externo (simulado).'))}>
            <span className="pv-menu__main">Adoptar un worktree externo…</span>
          </button>
        </div>
      </Popover>
    </>
  );
}

export function PreviewSidebar() {
  const s = usePreviewStore();
  const [filterOpen, setFilterOpen] = useState(false);
  const total = s.attention.length;
  const byKind = useMemo(() => {
    const names = { permission: ['permiso', 'permisos'], review: ['revisión', 'revisiones'], question: ['pregunta', 'preguntas'], failed: ['fallo', 'fallos'], conflict: ['conflicto', 'conflictos'], host: ['host', 'hosts'] };
    const k = {};
    s.attention.forEach((x) => { k[x.kind] = (k[x.kind] || 0) + 1; });
    return Object.entries(k).map(([kind, n]) => `${n} ${names[kind]?.[n === 1 ? 0 : 1] || kind}`).join(' · ');
  }, [s.attention]);
  const { chips } = s.filter;
  const filtering = Boolean(s.filter.q || chips.length || s.filter.hostId);
  const noMatches = filtering && !PROJECTS.some((p) => s.tasks.filter((t) => t.projectId === p.id).some((t) => attemptsOfTask(s, t.id).some((a) => matches(s, a, t, p))));

  return (
    <div className="pv-nav" aria-label="Projects, Tasks e Intentos">
      <div className="pv-nav__search">
        <label className="field">
          <I n="search" size={13} />
          <input value={s.filter.q} onChange={(e) => s.setFilter({ q: e.target.value })} placeholder="Buscar trabajo…" aria-label="Buscar trabajo" />
        </label>
        <button type="button" className={`ic${chips.length || s.filter.hostId ? ' is-on' : ''}`} onClick={() => setFilterOpen((v) => !v)} aria-label="Filtros" aria-expanded={filterOpen} title="Filtros"><I n="sliders" size={14} /></button>
        <NewMenu />
      </div>
      {filterOpen && (
        <div className="pv-nav__filter">
          <div className="pv-wrap">
            {CHIPS.map((ch) => (
              <button key={ch.id} type="button" className={`pv-chipbtn${chips.includes(ch.id) ? ' is-on' : ''}`} aria-pressed={chips.includes(ch.id)} onClick={() => s.setFilter({ chips: chips.includes(ch.id) ? chips.filter((x) => x !== ch.id) : [...chips, ch.id] })}>{ch.label}</button>
            ))}
          </div>
          <div className="pv-wrap">
            {s.hosts.map((h) => (
              <button key={h.id} type="button" className={`pv-chipbtn${s.filter.hostId === h.id ? ' is-on' : ''}`} aria-pressed={s.filter.hostId === h.id} onClick={() => s.setFilter({ hostId: s.filter.hostId === h.id ? null : h.id })}>{h.name}</button>
            ))}
          </div>
        </div>
      )}

      <button type="button" className={`pv-need${s.view === 'attention' ? ' is-sel' : ''}${total ? '' : ' is-calm'}`} onClick={() => s.setView('attention')}>
        <span className="pv-need__n mono">{total}</span>
        <span className="pv-need__text">
          <b>{total ? `${total === 1 ? 'Espera' : 'Esperan'} tu decisión` : 'Nada espera tu decisión'}</b>
          <small>{byKind || 'Los agentes trabajan dentro de su contrato.'}</small>
        </span>
        <I n="right" size={12} />
      </button>

      <div className="pv-tree" role="tree">
        {PROJECTS.map((p) => {
          const tasks = s.tasks.filter((t) => t.projectId === p.id);
          const atts = s.attempts.filter((a) => tasks.some((t) => t.id === a.taskId));
          const active = atts.filter((a) => a.state === 'working').length;
          const attn = s.attention.filter((x) => atts.some((a) => a.id === x.attemptId)).length;
          const open = filtering || Boolean(s.expanded[p.id]);
          const anyVisible = tasks.some((t) => attemptsOfTask(s, t.id).some((a) => matches(s, a, t, p)));
          if (!anyVisible && filtering) return null;
          return (
            <div key={p.id} className="pv-project" role="treeitem" aria-expanded={open}>
              <button type="button" className="pv-project__head" onClick={() => s.toggleExpanded(p.id)}>
                <I n={open ? 'down' : 'right'} size={12} />
                <span className="pv-project__name">{p.name}</span>
                <span className="panelhead__fill" />
                {!open && attn > 0 && <AttnFlag n={attn} />}
                <span className="pv-project__meta">{active > 0 ? `${active} en ejecución` : atts.length ? 'en reposo' : 'sin trabajo'}</span>
              </button>
              {open && (
                <div className="pv-project__body">
                  <div className="pv-main"><I n="branch" size={11} /><span className="mono">{p.branch}</span><span> · tu espacio de trabajo</span></div>
                  {tasks.map((t) => <TaskBlock key={t.id} task={t} project={p} />)}
                </div>
              )}
            </div>
          );
        })}
        {noMatches && (
          <div className="pv-empty" role="status">
            <b>Nada coincide</b>
            <span>{s.filter.q ? `«${s.filter.q}»` : 'Estos filtros'} no encuentra nada en ningún Project.</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setFilter({ q: '', chips: [], hostId: null })}>Limpiar la búsqueda</button>
          </div>
        )}
      </div>

    </div>
  );
}

