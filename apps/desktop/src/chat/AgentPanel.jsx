// AgentPanel.jsx — el agente como panel lateral (modos Editor y Diseño):
// cabecera con la conversación actual e historial, y el chat debajo.
import { useCallback, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Popover } from '../components/Popover';
import { SpinRing } from '../components/Ring';
import { ChatPanel } from './ChatPanel';
import { HistoryList } from './HistoryList';
import { IconChat, IconChevronDown, IconExpand, IconPlus, IconX } from '../components/Icons';

export function AgentHeaderTitle() {
  const title = useChatStore((s) => s.conversationTitle);
  const streaming = useChatStore((s) => s.streaming);
  const waiting = useChatStore((s) => !!s.pendingApproval || !!s.pendingQuestion);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button ref={ref} className="agenttitle" onClick={() => setOpen((v) => !v)}>
        {streaming && !waiting ? <SpinRing size={12} /> : <span className={`dot ${waiting ? 'dot--accent dot--pulse' : streaming ? 'dot--accent' : ''}`} />}
        <span className="agenttitle__text">{title || 'Nueva conversación'}</span>
        <IconChevronDown size={12} className={`chev ${open ? 'is-flipped' : ''}`} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} className="menu menu--history">
        <div onClick={(e) => { if (e.target.closest('.recent__btn')) close(); }}>
          <HistoryList />
        </div>
      </Popover>
    </>
  );
}

export function AgentPanel({ onClose }) {
  const newConversation = useChatStore((s) => s.newConversation);
  const setMode = useWorkbenchStore((s) => s.setMode);
  const setRightView = useWorkbenchStore((s) => s.setRightView);

  return (
    <div className="agentpanel">
      <div className="panelhead">
        <AgentHeaderTitle />
        <div className="panelhead__fill" />
        <button className="ic" onClick={() => setRightView('team')} title="Lixbon Team en este panel"><IconChat size={15} /></button>
        <button className="ic" onClick={() => setMode('agent')} title="Agente a pantalla completa (Ctrl 1)"><IconExpand size={15} /></button>
        <button className="ic" onClick={newConversation} title="Nueva conversación (Ctrl N)"><IconPlus size={16} /></button>
        {onClose && <button className="ic" onClick={onClose} title="Cerrar panel (Ctrl Alt B)"><IconX size={15} /></button>}
      </div>
      <ChatPanel />
    </div>
  );
}
