// GitMode.jsx — control de código: cambios y commit a la izquierda; diff,
// pull requests o GitHub Actions en el centro.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { RightDock } from '../layout/RightDock';
import { AgentPanel } from '../chat/AgentPanel';
import { Segmented } from '../components/Segmented';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { DiffView } from '../sections/SourceControl/DiffView';
import { GitHubView } from '../sections/SourceControl/GitHubView';
import { ActionsView } from '../sections/SourceControl/ActionsView';
import { ActivityRail } from './ActivityRail';
import { FileIcon } from '@lixbon/icons/file-icons';

const readMode = () => { try { return localStorage.getItem('lx_diff_mode') || 'inline'; } catch { return 'inline'; } };

export function GitMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const open = useWorkbenchStore((s) => s.modePanels.git.left);
  const rightOpen = useWorkbenchStore((s) => s.modePanels.git.right);
  const toggleAgent = useWorkbenchStore((s) => s.toggleAgent);
  const diffData = useAppStore((s) => s.diffData);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const { stage, unstage, discard, fileDiff } = useGitStore();
  const [tab, setTab] = useState('diff');
  const [viewMode, setViewMode] = useState(readMode);
  const [runId, setRunId] = useState(null);
  const [rightTab, setRightTab] = useState('pr');
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
      <ActivityRail />
      <Collapse open={open} size={Math.max(sizes.side, 240) + 8}>
        <Panel id="scm" className="sidepanel">
          <SourceControl selected={meta} onSelect={() => setTab('diff')} onOpenPr={() => setTab('pr')} />
        </Panel>
        <Gutter sizeKey="side" />
      </Collapse>
      <Panel id="diff" className="wb__grow gitmain">
        <div className="panelhead">
          <span className="gitmain__filetab">{tab === 'diff' && meta?.path && <FileIcon nombre={meta.path} size={16} />}{tab === 'diff' ? (diffData?.title.split('/').pop() || 'Cambios') : tab === 'pr' ? 'Pull requests' : 'GitHub Actions'}</span>
          <div className="panelhead__fill" />
          <details className="gitmain__options">
            <summary>Opciones</summary>
            <div>
              <Segmented value={tab} onChange={setTab} width={104} options={[{value:'diff',label:'Cambios'},{value:'pr',label:'Pull requests'},{value:'actions',label:'Actions'}]} />
              {tab === 'diff' && diffData && <>
              {meta?.path && !meta.staged && !meta.untracked && (
                <button className="lk is-danger" onClick={async () => { await discard(meta.path, false); await reopen(meta.path, false); }}>Descartar</button>
              )}
              {meta?.path && <button className="lk" onClick={toggleStage}>{meta.staged ? 'Quitar de preparados' : 'Preparar'}</button>}
              {meta?.path && <button className="lk" onClick={openInEditor}>Abrir</button>}
              </>}
            </div>
          </details>
          {tab === 'diff' && diffData && <Segmented
                size="sm"
                value={viewMode}
                onChange={changeView}
                width={84}
                options={[{ value: 'inline', label: 'Unificado' }, { value: 'split', label: 'Lado a lado' }]}
              />}
        </div>
        <div className="gitmain__body scroll">
          {tab === 'diff'
            ? (diffData ? <DiffView mode={viewMode} /> : <div className="changes__empty">Elige un archivo o un commit a la izquierda para ver su diff.</div>)
            : tab === 'pr'
              ? <GitHubView onOpenRun={(id) => { setRunId(id); setTab('actions'); }} />
              : <ActionsView runId={runId} onRunChange={setRunId} />}
        </div>
      </Panel>
      <RightDock open={rightOpen}>
        <div className="gitdock">
          <div className="panelhead"><Segmented size="sm" width={112} value={rightTab} onChange={setRightTab} options={[{value: 'pr', label: 'Pull request'}, {value: 'agent', label: 'Agente'}]} /></div>
          {rightTab === 'pr' ? <div className="gitdock__pr"><GitHubView compact onOpenRun={(id) => { setRunId(id); setTab('actions'); }} /></div> : <AgentPanel onClose={toggleAgent} />}
        </div>
      </RightDock>
    </div>
  );
}
