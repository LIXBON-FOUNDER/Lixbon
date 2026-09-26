// RemoteModal.jsx — contenido de la ventana de control remoto (/remote).
// Muestra el QR y el link de la sesión activa, o el arranque si no hay ninguna.
import { useState } from 'react';
import { useRemoteStore } from '../store/remoteStore';
import { IconCopy, IconCheck, IconEye, IconDevice, IconTerminal } from './Icons';

const FEATURES = [
  { Icon: IconEye, title: 'En vivo', desc: 'Archivos, comandos y respuestas del agente mientras ocurren.' },
  { Icon: IconCheck, title: 'Aprobaciones', desc: 'Acepta o rechaza cambios y comandos desde el teléfono.' },
  { Icon: IconTerminal, title: 'En esta máquina', desc: 'Todo se sigue ejecutando aquí; el teléfono solo lo maneja.' },
];

export function RemoteModal() {
  const { active, starting, session, shareUrl, qrSvg, error, start, stop } = useRemoteStore();
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* portapapeles no disponible */ }
  };

  if (!active) {
    return (
      <div className="remote">
        <div className="remote__hero">
          <span className="remote__icon"><IconDevice size={18} /></span>
          <div>
            <h3 className="remote__title">Maneja el agente desde el teléfono</h3>
            <p className="remote__lead">
              La sesión aparece en la sección <strong>Remote</strong> de la app Lixbon. Sin la app, el QR la abre en la web.
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
            {starting ? 'Creando sesión…' : 'Iniciar control remoto'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote remote--live">
      <div className="remote__qr">
        {qrSvg ? <img src={qrSvg} alt="QR de la sesión remota" /> : <span className="skeleton remote__qrph" />}
      </div>
      <div className="remote__side">
        <div className="remote__live"><span className="remote__pulse" />En vivo</div>
        <h3 className="remote__title">{session?.title || 'Sesión del agente'}</h3>
        <ol className="remote__steps">
          <li>Abre la app Lixbon y entra en <strong>Remote</strong>.</li>
          <li>O escanea el QR con la cámara e inicia sesión con tu cuenta.</li>
        </ol>
        <button className="remote__link" onClick={copyLink} title="Copiar link">
          <code>{shareUrl}</code>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
        <p className="remote__note">El link caduca en 24 h o al terminar la sesión.</p>
        <div className="remote__actions">
          <button className="pill-btn pill-btn--outline" onClick={copyLink}>{copied ? 'Copiado' : 'Copiar link'}</button>
          <button className="pill-btn pill-btn--outline remote__end" onClick={stop}>Terminar</button>
        </div>
      </div>
    </div>
  );
}
