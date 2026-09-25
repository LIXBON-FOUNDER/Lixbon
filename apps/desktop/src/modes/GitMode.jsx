// GitMode.jsx — control de código: cambios y commit a la izquierda; diff o
// pull request de la rama en el centro.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { Segmented } from '../components/Segmented';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { DiffView } from '../sections/SourceControl/DiffView';
import { GitHubView } from '../sections/SourceControl/GitHubView';

const readMode = () => { try { return localStorage.getItem('lx_diff_mode') || 'inline'; } catch { return 'inline'; } };

export function GitMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const open = useWorkbenchStore((s) => s.modePanels.git.left);
  const diffData = useAppStore((s) => s.diffData);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const { stage, unstage, discard, fileDiff } = useGitStore();
  const [tab, setTab] = useState(diffData ? 'diff' : 'pr');
  const [viewMode, setViewMode] = useState(readMode);
  const meta = diffData?.meta;

  useEffect(() => { if (diffData) setTab('diff'); }, [diffData]);

  const changeView = (m) => {
    setViewMode(m);
    try { localStorage.setItem('lx_diff_mode', m); } catch { /* sin almacenamiento */ }
  };

  const reopen = async (path, staged) => {
    const patch = await fileDiff(path, staged);
    useAppStore.getState().openDiff(`${path}${staged ? ' · preparado' : ''}`, patch || '# Sin diferencias', { path, staged });
  };
  const toggleStage = async () => {
    if (meta.staged) await unstage(meta.path); else await stage(meta.path);
    await reopen(meta.path, !meta.staged);
  };
  const openInEditor = () => {
    const sep = workspaceRoot.includes('\\') ? '\\' : '/';
    useWorkbenchStore.getState().setMode('editor');
    useFileViewStore.getState().open(workspaceRoot + sep + meta.path.replace(/\//g, sep));
  };

  return (
    <div className="wb wb--git">
      <Collapse open={open} size={Math.max(sizes.side, 300) + 6}>
        <Panel id="scm" className="sidepanel">
          <SourceControl selected={meta} onSelect={() => setTab('diff')} onOpenPr={() => setTab('pr')} />
        </Panel>
        <Gutter sizeKey="side" />
      </Collapse>
      <Panel id="diff" className="wb__grow gitmain">
        <div className="panelhead">
          <Segmented
            value={tab}
            onChange={setTab}
            width={112}
            options={[{ value: 'diff', label: 'Cambios' }, { value: 'pr', label: 'Pull request' }]}
          />
          {tab === 'diff' && diffData && <span className="mono panelhead__meta">{diffData.title}</span>}
          <div className="panelhead__fill" />
          {tab === 'diff' && diffData && (
            <>
              {meta?.path && !meta.staged && !meta.untracked && (
                <button className="lk is-danger" onClick={async () => { await discard(meta.path, false); await reopen(meta.path, false); }}>Descartar</button>
              )}
              {meta?.path && <button className="lk" onClick={toggleStage}>{meta.staged ? 'Quitar de preparados' : 'Preparar'}</button>}
              {meta?.path && <button className="lk" onClick={openInEditor}>Abrir</button>}
              <Segmented
                size="sm"
                value={viewMode}
                onChange={changeView}
                width={84}
                options={[{ value: 'split', label: 'Lado a lado' }, { value: 'inline', label: 'En línea' }]}
              />
            </>
          )}
        </div>
        <div className="gitmain__body scroll">
          {tab === 'diff'
            ? (diffData ? <DiffView mode={viewMode} /> : <div className="changes__empty">Elige un archivo o un commit a la izquierda para ver su diff.</div>)
            : <GitHubView />}
        </div>
      </Panel>
    </div>
  );
}
