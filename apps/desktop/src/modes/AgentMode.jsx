// AgentMode.jsx — el agente a pantalla completa: conversaciones, chat y los
// cambios que va haciendo.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore, newSession, useSessionsStore } from '../store/chatStore';
import { Popover } from '../components/Popover';
import { LogoMark } from '../components/Logo';
import { useProviders } from '../orch/providers/RolesSettings';
import { listProviders } from '../orch/providers/providersContract';
import { NewAgentItems } from '../orch/providers/NewAgentItems';
import { useCodexTermStore, useLeaveCodexOnChatChange } from '../orch/codexterm/codexTermStore';
import { CodexTabList, CodexTermArea } from '../orch/codexterm/CodexTabs';
import { CodexLaunchPanel } from '../orch/codexterm/CodexLaunchPanel';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { RightDock } from '../layout/RightDock';
import { ChatPanel } from '../chat/ChatPanel';
import { HistoryList } from '../chat/HistoryList';
import { ChangesPanel } from '../chat/ChangesPanel';
import { runCommand } from '../lib/commands';
import { IconPlus, IconDevice, IconDownload, IconChevronDown } from '../components/Icons';

const GAP = 8;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

function NewMenu({ providers }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  // Solo motores con chat llegan aquí; Codex va por openCodex (nunca newSession).
  const pick = (engine) => { close(); useCodexTermStore.getState().deactivate(); newSession(engine); };
  const openCodex = () => { close(); useCodexTermStore.getState().openLauncher(); };
  return (
    <>
      <button ref={ref} className="btn btn--primary btn--sm" onClick={() => setOpen((v) => !v)}>
        <IconPlus size={13} /> Nuevo <IconChevronDown size={11} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} align="right" className="menu newagent">
        <button className="menu__item" onClick={() => pick('lixbon')}><LogoMark size={14} /><span className="menu__main">Agente de Lixbon</span><span className="menu__kbd">Ctrl N</span></button>
        <NewAgentItems providers={providers} onPick={pick} onOpenTerminal={openCodex} />
      </Popover>
    </>
  );
}

export function AgentMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const panels = useWorkbenchStore((s) => s.modePanels.agent);
  const { workspaceRoot, currentModel, openModal } = useAppStore();
  const branch = useGitStore((s) => s.branch);
  const { conversationTitle, engine } = useChatStore();
  const ccModel = useChatStore((s) => {
    const id = s.ccInfo?.model || s.ccModel;
    return (s.ccModels || []).find((m) => m.value !== 'default' && (m.resolvedModel === id || m.value === id))?.displayName || id;
  });
  const model = engine === 'claude' ? `Claude Code${ccModel ? ` · ${ccModel}` : ''}` : currentModel;
  const meta = [baseName(workspaceRoot), branch, model].filter(Boolean).join(' · ');
  const { providers } = useProviders(listProviders);
  const codexView = useCodexTermStore((s) => (s.launcher ? 'launcher' : s.activeKey ? 'term' : null));
  const codexTab = useCodexTermStore((s) => s.tabs.find((t) => t.key === s.activeKey));
  const codexResume = useCodexTermStore((s) => s.launcherResume);
  // Elegir una sesión de chat vuelve del terminal de Codex al chat.
  const chatKey = useSessionsStore((s) => s.activeKey);
  useLeaveCodexOnChatChange(chatKey);

  return (
    <div className="wb wb--agent">
      <Collapse open={panels.left} size={sizes.sessions + GAP}>
        <Panel id="sessions" className="sessions">
          <div className="panelhead">
            <span className="panelhead__title">Agentes</span>
            <div className="panelhead__fill" />
            <NewMenu providers={providers} />
          </div>
          <CodexTabList />
          <HistoryList />
        </Panel>
        <Gutter sizeKey="sessions" />
      </Collapse>

      <Panel id="chat" className="wb__grow agentmain">
        <div className="panelhead panelhead--tall">
          <div className="agentmain__title">
            <span>{codexView === 'launcher' ? (codexResume ? 'Reanudar sesión de Codex' : 'Codex en una terminal') : codexView === 'term' ? 'Codex' : (conversationTitle || 'Nueva conversación')}</span>
            {codexView === 'term' && codexTab ? <span className="mono agentmain__meta">{codexTab.cwd}</span> : meta && <span className="mono agentmain__meta">{meta}</span>}
          </div>
          <div className="panelhead__fill" />
          <button className="ic" onClick={() => openModal('remote')} title="Seguir desde el móvil"><IconDevice size={16} /></button>
          <button className="ic" onClick={() => runCommand('chat.saveMarkdown')} title="Exportar a Markdown"><IconDownload size={16} /></button>
        </div>
        <div className="agentmain__body">
          {codexView === 'launcher' && (
            <CodexLaunchPanel cwd={codexResume?.cwd || workspaceRoot} resume={codexResume} codex={providers?.find((p) => p.id === 'codex') || null}
              onOpened={(res, args) => useCodexTermStore.getState().addTab(res, args)} onCancel={() => useCodexTermStore.getState().cancelLauncher()} />
          )}
          <div style={codexView ? { display: 'none' } : { display: 'contents' }}><ChatPanel wide /></div>
          <CodexTermArea />
        </div>
      </Panel>

      <RightDock open={panels.right} id="changes" sizeKey="changes">
        <ChangesPanel />
      </RightDock>
    </div>
  );
}
