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
    isRepo, branch, changes, loading, error, message,
    setMessage, refresh, stage, unstage, stageAll, commit,
    init, pull, push, fetch, cloneRepo, cloning, cloneProgress,
  } = useGitStore();
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);

  const [commitStatus, setCommitStatus] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneStatus, setCloneStatus] = useState(null); // { ok, text }

  // Refrescar al entrar y cuando cambia la carpeta de trabajo
  useEffect(() => { refresh(); }, [refresh, workspaceRoot]);

  const withTerminal = (fn) => {
    if (!panels.terminal) togglePanel('terminal');
    fn();
  };

  const handleCommit = async () => {
    setCommitStatus('');
    const res = await commit();
    if (!res.ok) setCommitStatus(res.error || 'No se pudo hacer commit.');
  };

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
    <div className="scm__file" key={(isStaged ? 's:' : 'u:') + c.path} title={c.path}>
      <span className={`scm__badge scm__badge--${c.untracked ? 'new' : c.index || c.wt}`}>
        {c.untracked ? 'U' : (c.staged ? c.index : c.wt)}
      </span>
      <span className="scm__file-name">{fileName(c.path)}</span>
      <span className="scm__file-path">{c.path}</span>
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
        <h2 className="center-view__title" style={{ margin: 0 }}>Control de código</h2>
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
            <IconGitBranch size={16} />
            <span className="scm__branch-name">{branch || '—'}</span>
            <span className="scm__net">
              <button className="scm__net-btn" onClick={() => withTerminal(fetch)} title="git fetch">
                <IconRefresh size={14} /> Fetch
              </button>
              <button className="scm__net-btn" onClick={() => withTerminal(pull)} title="git pull">
                <IconArrowDown size={14} /> Pull
              </button>
              <button className="scm__net-btn" onClick={() => withTerminal(push)} title="git push">
                <IconArrowUp size={14} /> Push
              </button>
            </span>
          </div>

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
              onClick={handleCommit}
              disabled={!message.trim() || staged.length === 0}
              title={staged.length === 0 ? 'No hay cambios en el stage' : 'Confirmar'}
            >
              <IconGitCommit size={15} /> Commit ({staged.length})
            </button>
          </div>
          {commitStatus && <p className="settings__status is-error">{commitStatus}</p>}

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
        </>
      )}
    </div>
  );
}
