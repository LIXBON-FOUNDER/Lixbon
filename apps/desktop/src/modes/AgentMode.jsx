// AgentMode.jsx — el agente a pantalla completa: conversaciones, chat y los
// cambios que va haciendo.
import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore, newSession } from '../store/chatStore';
import { useClaudeUsage } from '../store/claudeSession';
import { Popover } from '../components/Popover';
import { LogoMark, ClaudeMark } from '../components/Logo';
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
import { IconPlus, IconDevice, IconDownload, IconChevronDown } from '../components/Icons';

const GAP = 6;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

const resetOf = (secs) => (secs ? resetLabel(new Date(secs * 1000).toISOString()) : '');

function ClaudeQuota() {
  const { session, week } = useClaudeUsage();
  if (!session && !week) {
    return (
      <div className="quota quota--claude">
        <ClaudeMark size={18} />
        <span className="quota__text"><span>Uso de Claude</span><span className="quota__sub">aparece tras el primer mensaje</span></span>
      </div>
    );
  }
  return (
    <div className="quota quota--claude" title="Cupo de tu plan de Claude, según Claude Code">
      <ProgressRing value={session?.percent || 0} size={22} stroke={2.6} />
      <span className="quota__text">
        <span>Claude · sesión {session?.percent ?? 0}% · semana {week?.percent ?? 0}%</span>
        <span className="quota__sub">{resetOf(session?.resetAt)}</span>
      </span>
    </div>
  );
}

function NewMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = (engine) => { close(); newSession(engine); };
  return (
    <>
      <button ref={ref} className="btn btn--primary btn--sm" onClick={() => setOpen((v) => !v)}>
        <IconPlus size={13} /> Nuevo <IconChevronDown size={11} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} align="right" className="menu newagent">
        <button className="menu__item" onClick={() => pick('lixbon')}><LogoMark size={14} /><span className="menu__main">Agente de Lixbon</span><span className="menu__kbd">Ctrl N</span></button>
        <button className="menu__item" onClick={() => pick('claude')}><ClaudeMark size={14} /><span className="menu__main">Claude Code</span></button>
      </Popover>
    </>
  );
}

function SessionQuota() {
  const engine = useChatStore((s) => s.engine);
  const session = useUsageStore((s) => s.buckets?.session);
  const openModal = useAppStore((s) => s.openModal);
  if (engine === 'claude') return <ClaudeQuota />;
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
  const { conversationTitle, engine } = useChatStore();
  const ccModel = useChatStore((s) => s.ccInfo?.model || s.ccModel);
  const model = engine === 'claude' ? `Claude Code${ccModel ? ` · ${ccModel}` : ''}` : currentModel;
  const meta = [baseName(workspaceRoot), branch, model].filter(Boolean).join(' · ');

  return (
    <div className="wb wb--agent">
      <Collapse open={panels.left} size={sizes.sessions + GAP}>
        <Panel id="sessions" className="sessions">
          <div className="panelhead">
            <span className="panelhead__title">Agentes</span>
            <div className="panelhead__fill" />
            <NewMenu />
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
