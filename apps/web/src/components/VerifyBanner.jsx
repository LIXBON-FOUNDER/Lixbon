// No bloquea nada: quien decide si se puede usar sin verificar es el gateway
// (REQUIRE_EMAIL_VERIFICATION).
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { useT } from '../i18n/useT';

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
  const { user, verificationSent } = useAuth();
  const { estado, reenviar } = useReenvioVerificacion();
  const t = useT('chat');

  // Las cuentas heredadas sin correo no tienen nada que verificar.
  if (!user?.email || user.email_verified) return null;

  // Un fallo del reenvío pesa más que el resultado del registro: es lo último
  // que ha pasado y lo que el usuario acaba de provocar.
  const fallo = estado === 'error' || (estado === 'reposo' && verificationSent === false);

  const texto = fallo ? (
    <>{t('verifyFailedBefore')} <strong>{user.email}</strong>{t('verifyFailedAfter')}</>
  ) : estado === 'enviado' || verificationSent === true ? (
    <>{t('verifySentBefore')} <strong>{user.email}</strong> {t('verifySentAfter')}</>
  ) : (
    <>{t('verifyDefaultBefore')} <strong>{user.email}</strong>.</>
  );

  return (
    <div className={fallo ? 'verify-bar is-error' : 'verify-bar'} role="status">
      <span className="verify-bar__text">{texto}</span>
      {estado !== 'enviado' && (
        <button
          className="pill-btn pill-btn--outline verify-bar__btn"
          onClick={reenviar}
          disabled={estado === 'enviando'}
        >
          {estado === 'enviando' ? t('verifySending') : t('verifyResend')}
        </button>
      )}
    </div>
  );
}
