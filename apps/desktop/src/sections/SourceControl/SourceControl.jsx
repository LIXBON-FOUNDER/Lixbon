// SourceControl.jsx — panel de Git: rama, cambios (stage/commit) y red (pull/push/fetch/clone).
import { useEffect, useState } from 'react';
import { useGitStore } from '../../store/gitStore';
import { useAppStore } from '../../store/appStore';
import { pickDirectory } from '../../lib/tauri';
import {
  IconGitBranch, IconGitCommit, IconRefresh, IconPlus, IconX,
  IconArrowDown, IconArrowUp,
} from '../../components/Icons';

export function SourceControl() {
  const {
    isRepo, branch, changes, hasRemote, ahead, behind, netBusy, netError,
    loading, error, message,
    setMessage, refresh, stage, unstage, stageAll, commit,
    init, pull, push, fetch, sync, publish, cloneRepo, cloning, cloneProgress,
    fileDiff, log, commitDiff, branches, checkout, stash,
  } = useGitStore();
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const openDiff = useAppStore((s) => s.openDiff);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);

  const [commitStatus, setCommitStatus] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishUrl, setPublishUrl] = useState('');
  const [publishError, setPublishError] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneStatus, setCloneStatus] = useState(null); // { ok, text }
  const [showHistory, setShowHistory] = useState(false);
  const [commits, setCommits] = useState([]);
  const [branchMenu, setBranchMenu] = useState(false);
  const [branchList, setBranchList] = useState([]);
  const [newBranch, setNewBranch] = useState('');

  // Refrescar al entrar y cuando cambia la carpeta de trabajo
  useEffect(() => { refresh(); }, [refresh, workspaceRoot]);

  const openFileDiff = async (c, isStaged) => {
    const patch = await fileDiff(c.path, isStaged);
    openDiff(`${fileName(c.path)} ${isStaged ? '(preparado)' : '(cambios)'}`,
      patch || (c.untracked ? '# Archivo nuevo sin seguimiento (aún no rastreado por Git)' : '# Sin diferencias'));
  };

  const toggleHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) setCommits(await log(80));
  };

  const openBranchMenu = async () => {
    const next = !branchMenu;
    setBranchMenu(next);
    if (next) setBranchList(await branches());
  };

  const doCheckout = async (name, create = false) => {
    const res = await checkout(name, create);
    setBranchMenu(false);
    setNewBranch('');
    if (!res.ok) setCommitStatus(res.error);
  };

  const handlePublish = async () => {
    setPublishError('');
    const res = await publish(publishUrl);
    if (!res.ok) {
      setPublishError(res.error);
      return;
    }
    setPublishOpen(false);
    setPublishUrl('');
  };

  const handleCommit = async () => {
    setCommitStatus('');
    const res = await commit();
    if (!res.ok) setCommitStatus(res.error || 'No se pudo hacer commit.');
  };

  /** La acción principal, un solo botón que va cambiando de forma:
      hay cambios → Commit · hay commits sin subir → Push (N) · hay commits
      nuevos en el remoto → Pull · las dos cosas → Sincronizar.
      Los commits sin subir se van acumulando solos: si haces dos commits y no
      subes, `ahead` vale 2 y el botón dice "Push (2)". */
  const primaryAction = () => {
    if (netBusy) {
      const doing = { fetch: 'Buscando…', pull: 'Descargando…', push: 'Subiendo…', sync: 'Sincronizando…' };
      return { label: doing[netBusy] || 'Trabajando…', disabled: true, run: () => {}, icon: <IconRefresh size={15} /> };
    }
    if (changes.length > 0) {
      const blocked = !message.trim() || staged.length === 0;
      return {
        label: `Commit (${staged.length})`,
        icon: <IconGitCommit size={15} />,
        run: handleCommit,
        disabled: blocked,
        title: staged.length === 0
          ? 'Prepara algún cambio primero (+)'
          : !message.trim() ? 'Escribe un mensaje de commit' : 'Confirmar los cambios preparados',
      };
    }
    if (ahead > 0 && behind > 0) {
      return {
        label: `Sincronizar (↓${behind} ↑${ahead})`,
        icon: <IconRefresh size={15} />,
        run: sync,
        title: 'Traer los commits del remoto y subir los tuyos',
      };
    }
    if (ahead > 0) {
      return {
        label: `Push (${ahead})`,
        icon: <IconArrowUp size={15} />,
        run: push,
        title: `Subir ${ahead} ${ahead === 1 ? 'commit' : 'commits'} al remoto`,
      };
    }
    if (behind > 0) {
      return {
        label: `Pull Changes (${behind})`,
        icon: <IconArrowDown size={15} />,
        run: pull,
        title: `Descargar ${behind} ${behind === 1 ? 'commit' : 'commits'} del remoto`,
      };
    }
    return {
      label: hasRemote ? 'Todo sincronizado' : 'Sin cambios',
      icon: <IconGitCommit size={15} />,
      run: () => {},
      disabled: true,
    };
  };

  const action = primaryAction();

  const handleClone = async () => {
    const url = cloneUrl.trim();
    if (!url) return;
    const dest = await pickDirectory({ title: 'Carpeta donde crear el clon' });
    if (dest === null) return; // cancelado

    setCloneStatus(null);
    const res = await cloneRepo(url, dest);
    if (res.ok) {
      setCloneOpen(false);
      setCloneUrl('');
      setCloneStatus({ ok: true, text: `Repositorio clonado en ${res.target}. Abriendo carpeta…` });
      try {
        await openWorkspace(res.target); // refresca explorador y estado Git
      } catch (e) {
        setCloneStatus({ ok: false, text: `Clonado, pero no se pudo abrir la carpeta: ${e}` });
      }
    } else {
      setCloneStatus({ ok: false, text: res.error || 'No se pudo clonar el repositorio.' });
    }
  };

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);

  const fileName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  const row = (c, isStaged) => (
    <div className="scm__file" key={(isStaged ? 's:' : 'u:') + c.path} title="Clic para ver diferencias">
      <span className={`scm__badge scm__badge--${c.untracked ? 'new' : c.index || c.wt}`}>
        {c.untracked ? 'U' : (c.staged ? c.index : c.wt)}
      </span>
      <button className="scm__file-open" onClick={() => openFileDiff(c, isStaged)}>
        <span className="scm__file-name">{fileName(c.path)}</span>
        <span className="scm__file-path">{c.path}</span>
      </button>
      <button
        className="icon-btn scm__file-action"
        onClick={() => (isStaged ? unstage(c.path) : stage(c.path))}
        title={isStaged ? 'Quitar del stage' : 'Añadir al stage'}
      >
        {isStaged ? <IconX size={14} /> : <IconPlus size={14} />}
      </button>
    </div>
  );

  return (
    <div className="scm">
      <div className="scm__head">
        <span className="scm__title">Control de código</span>
        <button className="icon-btn" onClick={refresh} title="Refrescar" disabled={loading}>
          <IconRefresh size={16} />
        </button>
      </div>

      {error && <p className="settings__status is-error">{error}</p>}

      {isRepo === false ? (
        <section className="settings__panel">
          <p className="settings__hint">La carpeta de trabajo no es un repositorio Git.</p>
          <div className="settings__actions">
            <button className="pill-btn pill-btn--primary" onClick={init}>
              Inicializar repositorio
            </button>
            <button className="pill-btn pill-btn--outline" onClick={() => setCloneOpen((v) => !v)}>
              Clonar…
            </button>
          </div>
          {cloneOpen && (
            <div className="scm__clone">
              <input
                className="settings__input"
                placeholder="https://github.com/usuario/repo.git"
                value={cloneUrl}
                onChange={(e) => { setCloneUrl(e.target.value); setCloneStatus(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleClone(); }}
                spellCheck={false}
                disabled={cloning}
              />
              <button
                className="pill-btn pill-btn--primary"
                onClick={handleClone}
                disabled={cloning || !cloneUrl.trim()}
              >
                {cloning ? 'Clonando…' : 'Elegir carpeta y clonar'}
              </button>
            </div>
          )}
          {cloning && cloneProgress && (
            <p className="settings__status scm__clone-progress">{cloneProgress}</p>
          )}
          {cloneStatus && (
            <p className={`settings__status ${cloneStatus.ok ? '' : 'is-error'}`}>
              {cloneStatus.text}
            </p>
          )}
        </section>
      ) : (
        <>
          <div className="scm__branch">
            <button className="scm__branch-btn" onClick={openBranchMenu} title="Cambiar de rama">
              <IconGitBranch size={16} />
              <span className="scm__branch-name">{branch || '—'}</span>
            </button>

            {hasRemote ? (
              // Acciones finas. La habitual es el botón grande de abajo.
              <span className="scm__net">
                <button className="scm__net-btn" onClick={fetch} disabled={!!netBusy} title="git fetch">
                  <IconRefresh size={14} /> Fetch
                </button>
                <button className="scm__net-btn" onClick={pull} disabled={!!netBusy} title="git pull">
                  <IconArrowDown size={14} /> Pull
                </button>
                <button className="scm__net-btn" onClick={push} disabled={!!netBusy} title="git push">
                  <IconArrowUp size={14} /> Push
                </button>
              </span>
            ) : (
              // Sin remoto no hay nada que sincronizar: primero hay que decirle a
              // git a qué repositorio de GitHub subir.
              <span className="scm__net">
                <button
                  className="scm__net-btn scm__net-btn--sync"
                  onClick={() => setPublishOpen((v) => !v)}
                  title="Conectar con un repositorio remoto y subir la rama"
                >
                  <IconArrowUp size={14} /> Publicar en GitHub
                </button>
              </span>
            )}
          </div>

          {!hasRemote && publishOpen && (
            <div className="scm__clone">
              <p className="settings__hint">
                Crea el repositorio vacío en GitHub y pega aquí su URL. Se añadirá
                como <code>origin</code> y se subirá la rama <strong>{branch}</strong>.
              </p>
              <input
                className="settings__input"
                placeholder="https://github.com/usuario/repo.git"
                value={publishUrl}
                onChange={(e) => { setPublishUrl(e.target.value); setPublishError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePublish(); }}
                spellCheck={false}
              />
              <button
                className="pill-btn pill-btn--primary"
                onClick={handlePublish}
                disabled={!publishUrl.trim()}
              >
                Publicar
              </button>
              {publishError && <p className="settings__status is-error">{publishError}</p>}
            </div>
          )}

          {branchMenu && (
            <div className="scm__branchmenu">
              {branchList.map((b) => (
                <button
                  key={b.name}
                  className={`scm__branchitem ${b.current ? 'is-current' : ''}`}
                  onClick={() => !b.current && doCheckout(b.name)}
                >
                  <IconGitBranch size={13} /> {b.name}{b.current ? ' ·' : ''}
                </button>
              ))}
              <div className="scm__branchnew">
                <input
                  className="settings__input"
                  placeholder="Nueva rama…"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newBranch.trim()) doCheckout(newBranch.trim(), true); }}
                  spellCheck={false}
                />
                <button
                  className="scm__link"
                  disabled={!newBranch.trim()}
                  onClick={() => doCheckout(newBranch.trim(), true)}
                >
                  Crear
                </button>
              </div>
            </div>
          )}

          <div className="scm__commit">
            <textarea
              className="scm__message"
              placeholder="Mensaje de commit"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
            />
            <button
              className="pill-btn pill-btn--primary scm__commit-btn"
              onClick={action.run}
              disabled={action.disabled}
              title={action.title}
            >
              {action.icon} {action.label}
            </button>
          </div>
          {commitStatus && <p className="settings__status is-error">{commitStatus}</p>}
          {netError && <p className="settings__status is-error">{netError}</p>}

          {staged.length > 0 && (
            <div className="scm__group">
              <div className="scm__group-head">
                <span>Cambios preparados ({staged.length})</span>
              </div>
              {staged.map((c) => row(c, true))}
            </div>
          )}

          <div className="scm__group">
            <div className="scm__group-head">
              <span>Cambios ({unstaged.length})</span>
              {unstaged.length > 0 && (
                <button className="scm__link" onClick={stageAll}>Añadir todos</button>
              )}
            </div>
            {unstaged.length === 0 && staged.length === 0 ? (
              <p className="settings__hint">Sin cambios. El árbol de trabajo está limpio.</p>
            ) : (
              unstaged.map((c) => row(c, false))
            )}
          </div>

          <div className="scm__toolbar">
            <button className="scm__link" onClick={() => stash('push')} title="Guardar cambios en un stash">
              Stash
            </button>
            <button className="scm__link" onClick={() => stash('pop')} title="Recuperar el último stash">
              Stash pop
            </button>
            <button className="scm__link" onClick={toggleHistory}>
              {showHistory ? 'Ocultar historial' : 'Historial'}
            </button>
          </div>

          {showHistory && (
            <div className="scm__group scm__history">
              <div className="scm__group-head"><span>Commits recientes</span></div>
              {commits.length === 0 ? (
                <p className="settings__hint">Sin commits.</p>
              ) : (
                commits.map((c) => (
                  <button
                    key={c.hash}
                    className="scm__commit-row"
                    title={`${c.author} · ${c.date}`}
                    onClick={async () => openDiff(`${c.short} · ${c.subject}`, await commitDiff(c.hash))}
                  >
                    <span className="scm__commit-hash">{c.short}</span>
                    <span className="scm__commit-subject">{c.subject}</span>
                    <span className="scm__commit-meta">{c.date}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
