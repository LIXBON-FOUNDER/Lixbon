// AgentMode.jsx — el agente a pantalla completa: conversaciones, chat y los
// cambios que va haciendo.
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore } from '../store/chatStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { ChatPanel } from '../chat/ChatPanel';
import { HistoryList } from '../chat/HistoryList';
import { ChangesPanel } from '../chat/ChangesPanel';
import { runCommand } from '../lib/commands';
import { useUsageStore, resetLabel } from '../store/usageStore';
import { ProgressRing } from '../components/Ring';
import { IconPlus, IconDevice, IconDownload } from '../components/Icons';

const GAP = 6;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

function SessionQuota() {
  const session = useUsageStore((s) => s.buckets?.session);
  const openModal = useAppStore((s) => s.openModal);
  if (!session || session.unlimited) return null;
  const pct = Math.round(session.percent || 0);
  return (
    <button className="quota" onClick={() => openModal('settings', 'usage')}>
      <ProgressRing value={pct} size={22} stroke={2.6} />
      <span className="quota__text">
        <span>Sesión {pct}%</span>
        <span className="quota__sub">{resetLabel(session.reset_at)}</span>
      </span>
    </button>
  );
}

export function AgentMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const panels = useWorkbenchStore((s) => s.modePanels.agent);
  const { workspaceRoot, currentModel, openModal } = useAppStore();
  const branch = useGitStore((s) => s.branch);
  const { conversationTitle, newConversation } = useChatStore();
  const meta = [baseName(workspaceRoot), branch, currentModel].filter(Boolean).join(' · ');

  return (
    <div className="wb wb--agent">
      <Collapse open={panels.left} size={sizes.sessions + GAP}>
        <Panel id="sessions" className="sessions">
          <div className="panelhead">
            <span className="panelhead__title">Agentes</span>
            <div className="panelhead__fill" />
            <button className="btn btn--primary btn--sm" onClick={newConversation}><IconPlus size={13} /> Nuevo</button>
          </div>
          <HistoryList />
          <SessionQuota />
        </Panel>
        <Gutter sizeKey="sessions" />
      </Collapse>

      <Panel id="chat" className="wb__grow agentmain">
        <div className="panelhead panelhead--tall">
          <div className="agentmain__title">
            <span>{conversationTitle || 'Nueva conversación'}</span>
            {meta && <span className="mono agentmain__meta">{meta}</span>}
          </div>
          <div className="panelhead__fill" />
          <button className="ic" onClick={() => openModal('remote')} title="Seguir desde el móvil"><IconDevice size={16} /></button>
          <button className="ic" onClick={() => runCommand('chat.saveMarkdown')} title="Exportar a Markdown"><IconDownload size={16} /></button>
        </div>
        <div className="agentmain__body">
          <ChatPanel wide />
        </div>
      </Panel>

      <Collapse open={panels.right} size={sizes.changes + GAP} from="end">
        <Gutter sizeKey="changes" invert />
        <Panel id="changes">
          <ChangesPanel />
        </Panel>
      </Collapse>
    </div>
  );
}
