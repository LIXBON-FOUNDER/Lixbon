// AuthPage.jsx — acceso y registro sobre el fondo del clúster.
// Incluye el modo "olvidé mi contraseña" (request-password-reset).
// Botones OAuth Google/Apple: SOLO visuales por ahora (sin funcionalidad).
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { FloatingField } from '../components/FloatingField';
import { Logo } from '../components/Logo';
import { ClusterFondo } from '../components/ClusterFondo';
import { api } from '../lib/api';

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" width="17" height="17" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.4c-.5 2.9-2.1 5.4-4.6 7l7.6 5.9c4.4-4.1 6.7-10.1 6.7-17.2Z" />
      <path fill="#FBBC05" d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1Z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.4 0-11.7-3.7-13.6-9.9l-7.8 6.1C6.5 42.6 14.6 48 24 48Z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="#141414" aria-hidden="true">
      <path d="M16.7 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.9-3-.8c-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.7 1.1 8.9.8 1.1 1.7 2.3 2.9 2.2 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.2 1.2-2.4 1.2-2.5 0 0-2.4-.9-2.4-3.5Z" />
      <path d="M14.6 5.9c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.9 1 .1 2-.5 2.7-1.3Z" />
    </svg>
  );
}

const TITULOS = {
  login: 'Iniciar sesión',
  register: 'Crear cuenta',
  forgot: 'Restablecer contraseña',
};

export default function AuthPage() {
  const [params] = useSearchParams();
  const initialMode = params.get('mode') === 'register' ? 'register' : 'login';
  // Vuelta post-login (p.ej. /remote/<token> desde el QR). Solo rutas internas:
  // un next externo sería un open-redirect.
  const rawNext = params.get('next') || '';
  const nextPath = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  const [mode, setMode] = useState(initialMode); // 'login' | 'register' | 'forgot'
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setNotice('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        navigate(nextPath, { replace: true });
      } else if (mode === 'register') {
        if (password !== confirm) {
          setError('Las contraseñas no coinciden');
          return;
        }
        await register({ firstName, lastName, email, password });
        navigate(nextPath, { replace: true });
      } else {
        await api.post('/api/auth/request-password-reset', { email });
        setNotice('Si el correo existe, te enviamos un enlace para restablecer la contraseña.');
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Algo salió mal. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <ClusterFondo />

      <div className="auth__panel">
        <span className="tab" aria-hidden="true" />
        <form className="auth__card" onSubmit={handleSubmit}>
          <div className="auth__head">
            <Link to="/" className="auth__logo" aria-label="Volver al chat">
              <Logo />
            </Link>
            <h1 className="auth__title">{TITULOS[mode]}</h1>
          </div>

          {/* key={mode}: remonta el bloque para animar la entrada al cambiar de modo */}
          <div className="auth__fields" key={mode}>
            {mode === 'register' && (
              <div className="auth__row">
                <FloatingField label="Nombre" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
                <FloatingField label="Apellido" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
              </div>
            )}

            <FloatingField
              label="Correo electrónico"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="tu@correo.com"
            />

            {mode !== 'forgot' && (
              <FloatingField
                label="Contraseña"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
              />
            )}

            {mode === 'register' && (
              <FloatingField
                label="Confirmar contraseña"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
              />
            )}

            {mode === 'login' && (
              <button type="button" className="auth__link auth__link--right" onClick={() => switchMode('forgot')}>
                ¿Olvidaste tu contraseña?
              </button>
            )}
          </div>

          {error && <p className="auth__error" role="alert">{error}</p>}
          {notice && <p className="auth__notice">{notice}</p>}

          <div className="auth__actions">
            <button className="auth__cta" type="submit" disabled={busy}>
              {mode === 'login' && (busy ? 'Iniciando…' : 'Iniciar sesión')}
              {mode === 'register' && (busy ? 'Creando cuenta…' : 'Crear cuenta')}
              {mode === 'forgot' && (busy ? 'Enviando…' : 'Enviar enlace')}
            </button>

            {mode === 'login' && (
              <p className="auth__switch">
                ¿No tienes cuenta?{' '}
                <button type="button" onClick={() => switchMode('register')}>Regístrate</button>
              </p>
            )}
            {mode === 'register' && (
              <p className="auth__switch">
                ¿Ya tienes cuenta?{' '}
                <button type="button" onClick={() => switchMode('login')}>Inicia sesión</button>
              </p>
            )}
            {mode === 'forgot' && (
              <p className="auth__switch">
                <button type="button" onClick={() => switchMode('login')}>Volver a iniciar sesión</button>
              </p>
            )}
          </div>

          {/* OAuth: solo visual por ahora (sin funcionalidad) */}
          {mode !== 'forgot' && (
            <>
              <div className="auth__divider"><span>O</span></div>
              <div className="auth__social">
                <button type="button" className="auth__social-btn">
                  <GoogleLogo /> Google
                </button>
                <button type="button" className="auth__social-btn">
                  <AppleLogo /> Apple
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
