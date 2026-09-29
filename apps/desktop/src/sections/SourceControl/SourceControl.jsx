// SourceControl.jsx — panel izquierdo del modo Git: rama, mensaje de commit
// (con propuesta del modelo), cambios preparados y sin preparar, historial y
// el estado del pull request de la rama.
import { useEffect, useRef, useState } from 'react';
import { useGitStore } from '../../store/gitStore';
import { useAppStore } from '../../store/appStore';
import { pickDirectory } from '../../lib/tauri';
import { showConfirm } from '../../lib/confirm';
import { useGithubPr } from './GitHubView';
import { Popover } from '../../components/Popover';
import { SpinRing } from '../../components/Ring';
import { LogoMark } from '../../components/Logo';
import {
  IconGitBranch, IconRefresh, IconPlus, IconX, IconArrowDown, IconArrowUp, IconChevronDown, IconHistory, IconPullRequest,
} from '../../components/Icons';

const fileName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const dirName = (p) => p.split('/').slice(0, -1).join('/');

function Badge({ c }) {
  const code = c.untracked ? 'U' : c.staged ? c.index : c.wt;
  const tone = c.untracked || code === 'A' ? 'add' : code === 'D' ? 'del' : 'mod';
  return <span className={`scm2__badge scm2__badge--${tone}`}>{code}</span>;
}

function FileRow({ c, active, stat, onOpen, onStage, onDiscard }) {
  return (
    <div className={`scm2__file ${active ? 'is-active' : ''}`}>
      <button className="scm2__fileopen" onClick={onOpen} title={c.path}>
        <Badge c={c} />
        <span className="scm2__name">{fileName(c.path)}</span>
        <span className="mono scm2__dir">{dirName(c.path)}</span>
      </button>
      {stat && (stat.added || stat.removed) ? (
        <span className="mono diffstat scm2__stat"><em className="is-add">+{stat.added}</em> <em className="is-del">−{stat.removed}</em></span>
      ) : null}
      <span className="scm2__acts">
        {onDiscard && <button className="ic" onClick={onDiscard} title="Descartar cambios"><IconX size={13} /></button>}
        <button className="ic" onClick={onStage} title={c.staged ? 'Quitar de preparados' : 'Preparar'}>
          {c.staged ? <IconArrowDown size={13} /> : <IconPlus size={13} />}
        </button>
      </span>
    </div>
  );
}

function BranchMenu({ anchorRef, open, onClose, onError }) {
  const { branches, checkout, stash } = useGitStore();
  const [list, setList] = useState([]);
  const [name, setName] = useState('');
  useEffect(() => { if (open) branches().then(setList); }, [open, branches]);
  const go = async (n, create = false) => {
    const res = await checkout(n, create);
    onClose();
    setName('');
    if (!res.ok) onError(res.error);
  };
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} className="menu scm2__branchmenu">
      <div className="field field--strong">
        <input autoFocus value={name} placeholder="Crear rama…" spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go(name.trim(), true); }} />
      </div>
      <div className="scm2__branchlist">
        {list.map((b) => (
          <button key={b.name} className={`menu__item ${b.current ? 'is-active' : ''}`} onClick={() => !b.current && go(b.name)}>
            <IconGitBranch size={13} /> <span className="mono">{b.name}</span>
          </button>
        ))}
      </div>
      <div className="menu__sep" />
      <button className="menu__item" onClick={async () => { onClose(); const r = await stash('push'); if (!r.ok) onError(r.error); }}>Guardar cambios en stash</button>
      <button className="menu__item" onClick={async () => { onClose(); const r = await stash('pop'); if (!r.ok) onError(r.error); }}>Recuperar último stash</button>
    </Popover>
  );
}

function NoRepo() {
  const { init, cloneRepo, cloning, cloneProgress } = useGitStore();
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState(null);
  const clone = async () => {
    if (!url.trim()) return;
    const dest = await pickDirectory({ title: 'Carpeta donde crear el clon' });
    if (dest === null) return;
    setStatus(null);
    const res = await cloneRepo(url.trim(), dest);
    if (!res.ok) { setStatus(res.error || 'No se pudo clonar el repositorio.'); return; }
    try { await openWorkspace(res.target); } catch (e) { setStatus(`Clonado, pero no se pudo abrir: ${e}`); }
  };
  return (
    <div className="scm2__empty">
      <span>Esta carpeta no es un repositorio Git.</span>
      <button className="btn btn--primary" onClick={init}>Inicializar repositorio</button>
      <span className="fieldlabel">O clona uno</span>
      <div className="field field--strong">
        <input className="mono" value={url} placeholder="https://github.com/usuario/repo.git" spellCheck={false} disabled={cloning} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') clone(); }} />
        <button className="lk" onClick={clone} disabled={cloning || !url.trim()}>{cloning ? <SpinRing size={12} /> : 'Clonar'}</button>
      </div>
      {cloning && cloneProgress && <span className="mono scm2__muted">{cloneProgress}</span>}
      {status && <span className="scm2__error">{status}</span>}
    </div>
  );
}

function PrStrip({ onOpenPr }) {
  const { remoteUrl, branch } = useGitStore();
  const { pr, checks } = useGithubPr(remoteUrl, branch);
  if (!pr) return null;
  const state = pr.state === 'closed' ? (pr.merged_at ? 'fusionado' : 'cerrado') : pr.draft ? 'borrador' : 'abierto';
  const running = checks?.some((c) => !c.conclusion);
  const failed = checks?.some((c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'skipped');
  return (
    <button className="scm2__pr" onClick={onOpenPr}>
      <IconPullRequest size={14} />
      <span className="scm2__prtext">
        <span>PR #{pr.number} {state}</span>
        <span className="scm2__muted">{checks?.length ? (running ? 'checks en curso' : failed ? 'hay checks fallando' : 'checks pasando') : pr.title}</span>
      </span>
      {running && <SpinRing size={12} />}
      {!running && checks?.length > 0 && <span className={`dot ${failed ? 'dot--danger' : 'dot--good'}`} />}
    </button>
  );
}

export function SourceControl({ selected, onSelect, onOpenPr }) {
  const {
    isRepo, branch, changes, stats, hasRemote, ahead, behind, netBusy, netError, loading, error, message, generating,
    setMessage, refresh, stage, unstage, stageAll, unstageAll, commit, commitAndPush, discard, generateMessage,
    pull, push, fetch, publish, log, commitDiff, fileDiff,
  } = useGitStore();
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const openDiff = useAppStore((s) => s.openDiff);
  const [status, setStatus] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commits, setCommits] = useState([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishUrl, setPublishUrl] = useState('');
  const branchRef = useRef(null);

  useEffect(() => { refresh(); }, [refresh, workspaceRoot]);
  useEffect(() => { if (historyOpen) log(60).then(setCommits); }, [historyOpen, log, ahead, changes.length]);

  if (isRepo === false) return <div className="scm2"><NoRepo /></div>;

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);

  const open = async (c) => {
    const patch = await fileDiff(c.path, c.staged);
    openDiff(`${c.path}${c.staged ? ' · preparado' : ''}`,
      patch || (c.untracked ? '# Archivo nuevo sin seguimiento: prepáralo para ver su contenido como diff.' : '# Sin diferencias'),
      { path: c.path, staged: c.staged, untracked: c.untracked });
    onSelect?.();
  };

  const run = async (fn) => {
    setStatus('');
    const res = await fn();
    if (res && !res.ok && res.error) setStatus(res.error);
  };

  const askDiscard = async (c) => {
    const { choice } = await showConfirm({
      title: 'Descartar cambios',
      message: c.untracked ? `${c.path} se borrará: todavía no está en Git.` : `Se perderán los cambios sin preparar de ${c.path}.`,
      options: [{ id: 'yes', label: 'Descartar', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice === 'yes') run(() => discard(c.path, c.untracked));
  };

  const canCommit = staged.length > 0 && message.trim() && !netBusy;
  const netLabel = { fetch: 'Buscando', pull: 'Trayendo', push: 'Subiendo', sync: 'Sincronizando' }[netBusy];

  return (
    <div className="scm2">
      <div className="panelhead">
        <button ref={branchRef} className="scm2__branch" onClick={() => setBranchOpen((v) => !v)} title="Cambiar o crear rama">
          <IconGitBranch size={14} />
          <span className="mono">{branch || '—'}</span>
          {ahead > 0 && <span className="count">↑{ahead}</span>}
          {behind > 0 && <span className="count">↓{behind}</span>}
          <IconChevronDown size={12} />
        </button>
        <BranchMenu anchorRef={branchRef} open={branchOpen} onClose={() => setBranchOpen(false)} onError={setStatus} />
        <div className="panelhead__fill" />
        {netBusy ? <SpinRing size={13} /> : (
          <>
            <button className="ic" onClick={() => (hasRemote ? run(fetch) : refresh())} disabled={loading} title={hasRemote ? 'Buscar cambios en el remoto (fetch)' : 'Refrescar'}><IconRefresh size={14} /></button>
            {hasRemote && <button className="ic" onClick={() => run(pull)} title="Traer (pull)"><IconArrowDown size={14} /></button>}
            {hasRemote && <button className="ic" onClick={() => run(push)} title="Subir (push)"><IconArrowUp size={14} /></button>}
          </>
        )}
      </div>

      <div className="scm2__commit">
        <div className="scm2__msg">
          <textarea
            value={message}
            placeholder={staged.length ? 'Mensaje de commit' : 'Prepara cambios para hacer commit'}
            rows={message.includes('\n') ? 4 : 2}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && canCommit) run(commit); }}
          />
          <button className="lk scm2__gen" onClick={() => run(generateMessage)} disabled={generating || changes.length === 0}>
            {generating ? <SpinRing size={11} /> : <LogoMark size={11} />} Generar mensaje
          </button>
        </div>
        <div className="scm2__commitrow">
          <button className="btn btn--primary" onClick={() => run(commit)} disabled={!canCommit} title="Ctrl ↵">Commit{staged.length ? ` (${staged.length})` : ''}</button>
          <button className="btn btn--ghost" onClick={() => run(commitAndPush)} disabled={!canCommit || !hasRemote}>Commit y push</button>
          {netLabel && <span className="scm2__muted">{netLabel}…</span>}
        </div>
        {!hasRemote && (
          publishOpen ? (
            <div className="field field--strong drop-in">
              <input className="mono" autoFocus value={publishUrl} placeholder="URL del repositorio vacío en GitHub" spellCheck={false} onChange={(e) => setPublishUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(() => publish(publishUrl)).then(() => setPublishOpen(false)); }} />
              <button className="lk" onClick={() => run(() => publish(publishUrl))}>Publicar</button>
            </div>
          ) : <button className="lk scm2__publish" onClick={() => setPublishOpen(true)}><IconArrowUp size={13} /> Publicar rama en GitHub</button>
        )}
        {(status || netError || error) && <span className="scm2__error drop-in">{status || netError || error}</span>}
      </div>

      <div className="scm2__groups scroll">
        {staged.length > 0 && (
          <section className="scm2__group">
            <div className="scm2__grouphead">
              <span>Preparados</span><span className="count">{staged.length}</span>
              <div className="panelhead__fill" />
              <button className="lk" onClick={unstageAll}>Quitar todos</button>
            </div>
            {staged.map((c) => (
              <FileRow key={`s:${c.path}`} c={c} stat={stats.idx[c.path]} active={selected?.path === c.path && selected?.staged}
                onOpen={() => open(c)} onStage={() => run(() => unstage(c.path))} />
            ))}
          </section>
        )}
        <section className="scm2__group">
          <div className="scm2__grouphead">
            <span>Cambios</span><span className="count">{unstaged.length}</span>
            <div className="panelhead__fill" />
            {unstaged.length > 0 && <button className="lk" onClick={stageAll}>Preparar todos</button>}
          </div>
          {unstaged.length === 0 && staged.length === 0 && <span className="scm2__muted scm2__pad">El árbol de trabajo está limpio.</span>}
          {unstaged.map((c) => (
            <FileRow key={`u:${c.path}`} c={c} stat={stats.wt[c.path]} active={selected?.path === c.path && !selected?.staged}
              onOpen={() => open(c)} onStage={() => run(() => stage(c.path))} onDiscard={() => askDiscard(c)} />
          ))}
        </section>

        <section className="scm2__group">
          <button className="scm2__grouphead scm2__grouphead--btn" onClick={() => setHistoryOpen((v) => !v)}>
            <IconHistory size={13} /><span>Historial</span>
            <div className="panelhead__fill" />
            <IconChevronDown size={12} className={historyOpen ? 'is-flipped' : ''} />
          </button>
          {historyOpen && commits.map((c, i) => (
            <button key={c.hash} className="scm2__commitrow2" style={{ animationDelay: `${Math.min(i, 12) * 20}ms` }}
              onClick={async () => { openDiff(`${c.short} · ${c.subject}`, await commitDiff(c.hash), { commit: c.hash }); onSelect?.(); }}>
              <span className={`scm2__node ${i < ahead ? 'is-local' : ''}`} />
              <span className="scm2__subject">{c.subject}</span>
              <span className="mono scm2__muted">{c.short} · {c.date}</span>
            </button>
          ))}
        </section>
      </div>

      <PrStrip onOpenPr={onOpenPr} />
    </div>
  );
}
