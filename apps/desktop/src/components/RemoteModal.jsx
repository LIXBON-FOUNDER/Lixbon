// RemoteModal.jsx — contenido de la ventana de control remoto (/remote).
// Muestra el QR y el link de la sesión activa, o el arranque si no hay ninguna.
// Rotula el agente que se va a manejar (Lixbon o Claude Code): la app móvil
// muestra la sesión con esa misma marca.
import { useState } from 'react';
import { useRemoteStore } from '../store/remoteStore';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { ClaudeMark, LogoMark } from './Logo';
import { IconCopy, IconCheck, IconEye, IconTerminal, IconClip } from './Icons';

const AGENTS = {
  lixbon: { name: 'Lixbon', lead: 'el agente de Lixbon' },
  claude: { name: 'Claude Code', lead: 'Claude Code' },
};

const FEATURES = [
  { Icon: IconEye, title: 'En vivo', desc: 'Archivos, comandos y respuestas del agente mientras ocurren.' },
  { Icon: IconClip, title: 'Adjuntos y menciones', desc: 'Manda fotos, documentos y @archivos del proyecto desde el teléfono.' },
  { Icon: IconCheck, title: 'Aprobaciones y comandos', desc: 'Acepta cambios y usa los comandos "/" del agente.' },
  { Icon: IconTerminal, title: 'En esta máquina', desc: 'Todo se sigue ejecutando aquí; el teléfono solo lo maneja.' },
];

function AgentMark({ agent, size }) {
  return agent === 'claude' ? <ClaudeMark size={size} /> : <LogoMark size={size} />;
}

export function RemoteModal() {
  const { active, starting, session, shareUrl, qrSvg, error, start, stop } = useRemoteStore();
  const agent = useChatStore((s) => (s.engine === 'claude' ? 'claude' : 'lixbon'));
  const conversationTitle = useChatStore((s) => s.conversationTitle);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const workspace = workspaceRoot ? workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  const [copied, setCopied] = useState(false);
  const info = AGENTS[agent];

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* portapapeles no disponible */ }
  };

  const badge = (
    <span className={`remote__agent remote__agent--${agent}`}>
      <AgentMark agent={agent} size={12} />
      {info.name}
      {workspace && <span className="remote__agent-ws">{workspace}</span>}
    </span>
  );

  if (!active) {
    return (
      <div className={`remote remote--${agent}`}>
        <div className="remote__hero">
          <span className="remote__icon"><AgentMark agent={agent} size={20} /></span>
          <div>
            {badge}
            <h3 className="remote__title">Maneja {info.lead} desde el teléfono</h3>
            <p className="remote__lead">
              La sesión aparece en la sección <strong>Remoto</strong> de la app Lixbon con su nombre y su agente. Sin la app, el QR la abre en la web.
            </p>
          </div>
        </div>
        <ul className="remote__features">
          {FEATURES.map(({ Icon, title, desc }) => (
            <li key={title}>
              <span className="remote__ficon"><Icon size={14} /></span>
              <span><strong>{title}</strong>{desc}</span>
            </li>
          ))}
        </ul>
        {error && <p className="remote__error">{error}</p>}
        <div className="remote__actions">
          <button className="pill-btn pill-btn--primary" onClick={start} disabled={starting}>
            {starting ? 'Creando sesión…' : `Controlar ${info.name} en remoto`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`remote remote--live remote--${agent}`}>
      <div className="remote__qr">
        {qrSvg ? <img src={qrSvg} alt="QR de la sesión remota" /> : <span className="skeleton remote__qrph" />}
      </div>
      <div className="remote__side">
        <div className="remote__live"><span className="remote__pulse" />En vivo</div>
        {badge}
        <h3 className="remote__title">{conversationTitle || session?.title || 'Conversación nueva'}</h3>
        <ol className="remote__steps">
          <li>Abre la app Lixbon y entra en <strong>Remoto</strong>.</li>
          <li>O escanea el QR con la cámara e inicia sesión con tu cuenta.</li>
        </ol>
        <button className="remote__link" onClick={copyLink} title="Copiar link">
          <code>{shareUrl}</code>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
        <p className="remote__note">Sigue a la conversación que tengas abierta. El link caduca en 24 h o al terminar la sesión.</p>
        <div className="remote__actions">
          <button className="pill-btn pill-btn--outline" onClick={copyLink}>{copied ? 'Copiado' : 'Copiar link'}</button>
          <button className="pill-btn pill-btn--outline remote__end" onClick={stop}>Terminar</button>
        </div>
      </div>
    </div>
  );
}
