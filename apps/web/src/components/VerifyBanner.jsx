// VerifyBanner.jsx — aviso de "verifica tu correo" con botón de reenvío.
//
// Hasta ahora la única señal de que un correo estaba sin verificar era la
// palabra "Sin verificar" en Ajustes → Cuenta: nadie entra ahí a mirar, así que
// una cuenta podía quedarse sin verificar para siempre sin enterarse. Este
// aviso aparece donde el usuario ya está (el chat) y trae la única acción que
// resuelve el problema.
//
// No bloquea nada por sí solo: quien decide si el servicio se puede usar sin
// verificar es el gateway (REQUIRE_EMAIL_VERIFICATION).
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';

/** Reenvío del correo de verificación: 'reposo' | 'enviando' | 'enviado' | 'error'. */
export function useReenvioVerificacion() {
  const [estado, setEstado] = useState('reposo');

  const reenviar = async () => {
    setEstado('enviando');
    try {
      await api.post('/api/auth/resend-verification');
      setEstado('enviado');
    } catch {
      // El 502 del gateway significa que el correo no llegó a salir: decir
      // "enviado" aquí sería mandar a esperar un correo que no existe.
      setEstado('error');
    }
  };

  return { estado, reenviar };
}

export function VerifyBanner() {
  const { user } = useAuth();
  const { estado, reenviar } = useReenvioVerificacion();

  // Las cuentas heredadas sin correo no tienen nada que verificar.
  if (!user?.email || user.email_verified) return null;

  return (
    <div className="verify-bar" role="status">
      <span className="verify-bar__text">
        {estado === 'enviado' ? (
          <>Te enviamos un enlace a <strong>{user.email}</strong>. Revisa también la carpeta de spam.</>
        ) : estado === 'error' ? (
          <>No pudimos enviar el correo ahora mismo. Vuelve a intentarlo en unos minutos.</>
        ) : (
          <>Verifica tu correo electrónico para asegurar tu cuenta. Enviamos el enlace a <strong>{user.email}</strong>.</>
        )}
      </span>
      {estado !== 'enviado' && (
        <button
          className="pill-btn pill-btn--outline verify-bar__btn"
          onClick={reenviar}
          disabled={estado === 'enviando'}
        >
          {estado === 'enviando' ? 'Enviando…' : 'Reenviar correo'}
        </button>
      )}
    </div>
  );
}
