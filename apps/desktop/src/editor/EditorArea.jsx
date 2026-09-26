// EditorArea.jsx — pestañas, ruta y editor del archivo activo.
import { useEffect, useMemo, useState } from 'react';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useChatStore } from '../store/chatStore';
import { CodeEditor, forgetEditorState } from './CodeEditor';
import { InlineEdit } from './InlineEdit';
import { getActiveView } from './CodeEditor';
import { acceptFile, acceptHunk, rejectFile, rejectHunk, jumpHunk } from './reviewActions';
import { useBaseline } from '../store/reviewStore';
import { useProblemsStore } from '../store/problemsStore';
import { diffHunks, diffStats } from '../lib/lineDiff';
import { SpinRing } from '../components/Ring';
import { LogoMark } from '../components/Logo';
import { IconX, IconChevronRight, IconChevronUp, IconChevronDown, IconFolderOpen } from '../components/Icons';
import { runCommand } from '../lib/commands';
import { McpDetail } from '../sections/Extensions/McpDetail';
import { FilePreview, VisualFrame } from './FilePreview';
import { Segmented } from '../components/Segmented';
import { previewKind, viewOf } from '../lib/preview';

const VIEWS = [
  { value: 'code', label: 'Código', title: 'Solo el código' },
  { value: 'split', label: 'Dividido', title: 'Código y vista previa' },
  { value: 'preview', label: 'Vista', title: 'Solo la vista previa (Ctrl Mayús V)' },
];


const AGENT_MARK_MS = 20000;

function relPath(root, path) {
  if (!root || !path.startsWith(root)) return path;
  return path.slice(root.length).replace(/^[\\/]/, '');
}

function onReview(path, action, index) {
  const view = getActiveView();
  if (!view) return;
  if (action === 'accept') acceptHunk(view, path, index);
  else if (action === 'reject') rejectHunk(view, path, index);
  else if (action === 'acceptAll') acceptFile(path);
  else if (action === 'rejectAll') rejectFile(view, path);
  else if (action === 'next') jumpHunk(view, 1);
  else if (action === 'prev') jumpHunk(view, -1);
}

function ReviewBar({ path, baseline, content }) {
  const hunks = useMemo(() => diffHunks(baseline ?? '', content), [baseline, content]);
  const { added, removed } = diffStats(hunks);
  if (!hunks.length) return null;
  return (
    <div className="reviewbar">
      <span className="dot dot--accent" />
      <span className="reviewbar__text">
        {baseline === null ? 'El agente creó este archivo' : 'El agente cambió este archivo'}
        <span className="mono reviewbar__meta">{hunks.length} {hunks.length === 1 ? 'bloque' : 'bloques'} · <em className="is-add">+{added}</em> <em className="is-del">−{removed}</em></span>
      </span>
      <button className="ic" onClick={() => onReview(path, 'prev')} title="Bloque anterior (Alt ↑)"><IconChevronUp size={14} /></button>
      <button className="ic" onClick={() => onReview(path, 'next')} title="Bloque siguiente (Alt ↓)"><IconChevronDown size={14} /></button>
      <div className="panelhead__fill" />
      <button className="lk" onClick={() => onReview(path, 'rejectAll')} title="Ctrl Mayús ⌫">Rechazar todo</button>
      <button className="btn btn--accent btn--sm" onClick={() => onReview(path, 'acceptAll')}>Aceptar todo <kbd>Ctrl ↵</kbd></button>
    </div>
  );
}

function Tabs() {
  const { tabs, activePath, activate, close, agentTouched } = useFileViewStore();
  const streaming = useChatStore((s) => s.streaming);
  const now = Date.now();

  const closeTab = (path) => close(path).then(() => {
    if (!useFileViewStore.getState().tabs.some((t) => t.path === path)) forgetEditorState(path);
  });

  return (
    <div className="edtabs">
      {tabs.map((t) => {
        const dirty = !t.loading && t.content !== t.saved;
        const byAgent = streaming && agentTouched[t.path] && now - agentTouched[t.path] < AGENT_MARK_MS;
        return (
          <div
            key={t.path}
            className={`edtab ${t.path === activePath ? 'is-active' : ''}`}
            onClick={() => activate(t.path)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(t.path); }}
            title={t.path}
          >
            <span className="edtab__name">{t.name}</span>
            {byAgent && <span className="dot dot--accent dot--pulse" title="El agente editó este archivo" />}
            <button
              className={`edtab__close ${dirty ? 'is-dirty' : ''}`}
              onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
              aria-label={`Cerrar ${t.name}`}
            >
              <span className="edtab__dirty" />
              <IconX size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EmptyEditor() {
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  return (
    <div className="edempty">
      <LogoMark size={40} />
      <div className="edempty__title">{workspaceRoot ? 'Abre un archivo para empezar' : 'Abre una carpeta de trabajo'}</div>
      <div className="edempty__keys">
        {workspaceRoot ? (
          <>
            <button className="lk" onClick={() => runCommand('workbench.quickOpen')}>Ir a archivo <kbd>Ctrl P</kbd></button>
            <button className="lk" onClick={() => runCommand('workbench.search')}>Buscar en el proyecto <kbd>Ctrl Shift F</kbd></button>
            <button className="lk" onClick={() => runCommand('workbench.commandPalette')}>Todos los comandos <kbd>Ctrl Shift P</kbd></button>
            <button className="lk" onClick={() => runCommand('mode.agent')}>Pedirle algo al agente <kbd>Ctrl 1</kbd></button>
          </>
        ) : (
          <button className="lk" onClick={() => runCommand('chat.openWorkspace')}><IconFolderOpen size={14} /> Abrir carpeta…</button>
        )}
      </div>
    </div>
  );
}

export function EditorArea() {
  const { tabs, activePath, update, save, setCursor, reveal, views, setView } = useFileViewStore();
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const options = useWorkbenchStore((s) => s.editor);
  const streaming = useChatStore((s) => s.streaming);
  const tab = tabs.find((t) => t.path === activePath);
  const [inlinePath, setInlinePath] = useState(null);
  const baseline = useBaseline(tab && !tab.virtual ? tab.path : null);
  const problems = useProblemsStore((s) => s.problems);
  const diagnostics = useMemo(() => (tab ? problems.filter((p) => p.path === tab.path) : []), [problems, tab?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!activePath) setCursor(null); }, [activePath, setCursor]);

  const view = viewOf(tab, views, baseline !== undefined);
  const canPreview = tab && !tab.virtual && !!previewKind(tab.path);
  const showEditor = tab && !tab.virtual && !tab.loading && !(tab.error && !tab.content);

  const crumbs = tab && !tab.virtual ? relPath(workspaceRoot, tab.path).split(/[\\/]/) : [];

  return (
    <div className="editorarea">
      <div className="editorarea__head">
        <Tabs />
        {streaming && tab && !tab.virtual && (
          <span className="editorarea__agent"><SpinRing size={11} /> El agente está trabajando</span>
        )}
      </div>
      {tab && !tab.virtual && (
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className={`crumbs__part ${i === crumbs.length - 1 ? 'is-last' : ''}`}>
              {i > 0 && <IconChevronRight size={11} />}
              {c}
            </span>
          ))}
          {canPreview && (
            <Segmented className="crumbs__views" size="sm" width={64} options={VIEWS} value={view} onChange={(v) => setView(tab.path, v)} />
          )}
        </div>
      )}
      {tab && !tab.virtual && !tab.loading && baseline !== undefined && (
        <ReviewBar path={tab.path} baseline={baseline} content={tab.content} />
      )}
      <div className="editorarea__body">
        {!tab && <EmptyEditor />}
        {tab?.virtual && tab.path.startsWith('visual://') && <VisualFrame url={tab.url} label={tab.name} />}
        {tab?.virtual && !tab.path.startsWith('visual://') && <McpDetail path={tab.path} />}
        {tab && tab.loading && (
          <div className="edloading">
            <span className="skeleton" style={{ width: '42%' }} />
            <span className="skeleton" style={{ width: '64%' }} />
            <span className="skeleton" style={{ width: '30%' }} />
          </div>
        )}
        {tab && !tab.loading && tab.error && !tab.content && <div className="ederror">{tab.error}</div>}
        {showEditor && view === 'preview' && <FilePreview tab={tab} />}
        {showEditor && view !== 'preview' && (
          <div className={view === 'split' ? 'edsplit' : 'edsingle'}>
            <div className="edsplit__pane">
              <CodeEditor
                path={tab.path}
                content={tab.content}
                options={options}
                reveal={reveal}
                onChange={(text) => update(tab.path, text)}
                onSave={() => save(tab.path)}
                onCursor={setCursor}
                onInlineEdit={() => setInlinePath(tab.path)}
                baseline={baseline}
                diagnostics={diagnostics}
                onReview={(action, index) => onReview(tab.path, action, index)}
              />
            </div>
            {view === 'split' && <div className="edsplit__pane edsplit__pane--preview"><FilePreview tab={tab} /></div>}
          </div>
        )}
        {tab && inlinePath === tab.path && (
          <InlineEdit key={tab.path} path={tab.path} relPath={relPath(workspaceRoot, tab.path)} onClose={() => setInlinePath(null)} />
        )}
      </div>
    </div>
  );
}
