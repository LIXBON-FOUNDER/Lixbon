// EditorMode.jsx — archivos, editor, terminal y agente lado a lado.
// Se mantiene montado aunque se cambie de modo: los PTY del terminal y el
// estado del editor viven aquí. Los paneles se pliegan animados sin
// desmontarse (Collapse).
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useChatStore } from '../store/chatStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { ActivityRail } from './ActivityRail';
import { EditorArea } from '../editor/EditorArea';
import { BottomDock } from '../editor/BottomDock';
import { AgentPanel } from '../chat/AgentPanel';
import { FileTree } from '../sections/Workspace/FileTree';
import { SearchPanel } from '../sections/Search/SearchPanel';
import { McpList } from '../sections/Extensions/McpList';
import { LogoMark } from '../components/Logo';
import { SpinRing } from '../components/Ring';
import { lazy, Suspense } from 'react';

const TeamDock = lazy(() => import('../team/dock/TeamDock'));

const GAP = 6;

function AgentRail({ visible, onOpen }) {
  const streaming = useChatStore((s) => s.streaming);
  const waiting = useChatStore((s) => !!s.pendingApproval || !!s.pendingQuestion);
  return (
    <div className={`agentrail ${visible ? 'is-visible' : ''}`}>
      <button className="agentrail__btn" onClick={onOpen} title="Abrir el agente (Ctrl Alt B)">
        {streaming && <SpinRing size={28} />}
        <LogoMark size={15} />
      </button>
      {waiting && <span className="dot dot--accent dot--pulse" title="El agente espera tu permiso" />}
    </div>
  );
}

export function EditorMode({ active }) {
  const { sideOpen, sideView, agentOpen, rightView, sizes, toggleAgent, toggleSide, setSize, persistSizes } = useWorkbenchStore();
  const terminalOpen = useAppStore((s) => s.panels.terminal);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);

  return (
    <div className="wb wb--editor" style={{ display: active ? 'flex' : 'none' }}>
      <ActivityRail />

      <Collapse open={sideOpen} size={sizes.side + GAP}>
        <Panel id="side" className="sidepanel">
          {sideView === 'files' && <FileTree />}
          {sideView === 'search' && <SearchPanel />}
          {sideView === 'extensions' && <McpList />}
        </Panel>
        <Gutter sizeKey="side" onDoubleClick={toggleSide} />
      </Collapse>

      <div className="wb__col">
        <Panel id="code" className="wb__grow">
          <EditorArea />
        </Panel>
        <Collapse axis="y" open={terminalOpen} size={sizes.terminal + GAP}>
          <Gutter dir="y" sizeKey="terminal" invert onDoubleClick={() => { setSize('terminal', sizes.terminal > 300 ? 190 : 420); persistSizes(); }} />
          <Panel id="term" className="termdock">
            <BottomDock onClose={toggleTerminal} />
          </Panel>
        </Collapse>
      </div>

      <Collapse open={agentOpen} size={sizes.agent + GAP} from="end">
        <Gutter sizeKey="agent" invert onDoubleClick={toggleAgent} />
        <Panel id="agent">
          {rightView === 'team'
            ? <Suspense fallback={null}><TeamDock onClose={toggleAgent} /></Suspense>
            : <AgentPanel onClose={toggleAgent} />}
        </Panel>
      </Collapse>
      <AgentRail visible={!agentOpen} onOpen={toggleAgent} />
    </div>
  );
}
