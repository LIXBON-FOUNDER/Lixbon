// RemoteModal.jsx — contenido de la ventana de control remoto (/remote).
// Muestra el QR y el link de la sesión activa, o el arranque si no hay ninguna.
import { useState } from 'react';
import { useRemoteStore } from '../store/remoteStore';
import { IconCopy, IconCheck, IconGlobe } from './Icons';

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
      <div className="remote-modal">
        <p className="remote-modal__desc">
          Controla esta sesión del agente desde tu teléfono: la sesión aparece al
          instante en la sección <strong>Remote</strong> de la app Lixbon, y el QR
          abre la misma sesión en la web si no tienes la app instalada.
        </p>
        <p className="remote-modal__desc remote-modal__desc--dim">
          Verás en vivo lo que hace el agente (archivos, comandos, resultados) y
          las aprobaciones te llegarán al teléfono. Todo se ejecuta en esta máquina.
        </p>
        {error && <p className="remote-modal__error">{error}</p>}
        <button className="pill-btn pill-btn--primary" onClick={start} disabled={starting}>
          {starting ? 'Creando sesión…' : 'Iniciar control remoto'}
        </button>
      </div>
    );
  }

  return (
    <div className="remote-modal">
      <div className="remote-modal__status">
        <span className="statusbar__dot is-connected" />
        Sesión activa: <strong>{session?.title}</strong>
      </div>
      {qrSvg && (
        <div className="remote-modal__qr">
          <img src={qrSvg} alt="QR de la sesión remota" />
        </div>
      )}
      <div className="remote-modal__link">
        <IconGlobe size={14} />
        <code>{shareUrl}</code>
        <button className="icon-btn" onClick={copyLink} title="Copiar link">
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      <p className="remote-modal__desc remote-modal__desc--dim">
        El link expira en 24 h y deja de valer al terminar la sesión. Para
        entrar hay que iniciar sesión con tu misma cuenta Lixbon.
      </p>
      <button className="pill-btn pill-btn--outline remote-modal__end" onClick={stop}>
        Terminar sesión remota
      </button>
    </div>
  );
}
