// AuthPage.jsx — login/registro con toggle segmentado animado (mockups 2.3 y 2.4).
// Incluye el modo "olvidé mi contraseña" (request-password-reset).
// Botones OAuth Google/Apple: SOLO visuales por ahora (sin funcionalidad).
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { FloatingField } from '../components/FloatingField';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
      <path d="M16.36 12.79c-.03-2.53 2.07-3.74 2.16-3.8-1.18-1.72-3.01-1.96-3.66-1.99-1.56-.16-3.04.92-3.83.92-.79 0-2.01-.9-3.3-.87-1.7.02-3.27.99-4.14 2.5-1.77 3.07-.45 7.61 1.27 10.1.84 1.22 1.84 2.59 3.16 2.54 1.27-.05 1.75-.82 3.28-.82 1.53 0 1.96.82 3.3.79 1.36-.02 2.22-1.24 3.05-2.46.96-1.41 1.36-2.78 1.38-2.85-.03-.01-2.64-1.01-2.67-4.02zM13.84 5.35c.7-.85 1.17-2.03 1.04-3.21-1.01.04-2.23.67-2.95 1.52-.65.75-1.22 1.95-1.06 3.1 1.12.09 2.27-.57 2.97-1.41z" />
    </svg>
  );
}

// Estrella de 4 puntas (motivo "sparkle" de la ilustración animada)
function Spark({ size = 18, color = '#6C7A46', style, delay }) {
  return (
    <span className="spark" style={{ color, animationDelay: delay, ...style }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z" />
      </svg>
    </span>
  );
}

function CoreSpark() {
  return (
    <svg width="52%" height="52%" viewBox="0 0 24 24" fill="#F2F1E3" aria-hidden="true">
      <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z" />
    </svg>
  );
}

// Ilustración de fondo (motion) del rediseño Claude Design "Folax Login".
// Decorativa: se anima con CSS y se oculta en pantallas estrechas.
function AuthIllustration() {
  return (
    <div className="auth-illu" aria-hidden="true">
      {/* Destellos ambientales */}
      <Spark size={22} color="#6C7A46" style={{ left: '14%', top: '20%' }} />
      <Spark size={16} color="#C7BE9F" style={{ left: '9%', bottom: '16%' }} delay="0.6s" />
      <Spark size={18} color="#6C7A46" style={{ right: '13%', top: '24%' }} delay="1.1s" />
      <Spark size={14} color="#1B1A17" style={{ right: '17%', bottom: '22%' }} delay="1.6s" />

      {/* Cluster izquierdo: núcleo de IA */}
      <div className="auth-illu__cluster auth-illu__cluster--left">
        <div className="auth-illu__stage auth-illu__stage--left">
          <div className="auth-illu__glow" />

          <div className="auth-illu__ring" style={{ width: '100%', height: '100%', border: '1.5px dashed rgba(75,83,39,.28)', '--dur': '52s' }}>
            <span className="auth-illu__ring-dot" style={{ width: 9, height: 9, background: '#6C7A46', top: -5 }} />
          </div>
          <div className="auth-illu__ring is-reverse" style={{ width: '74%', height: '74%', border: '1.5px solid rgba(75,83,39,.22)', '--dur': '38s' }}>
            <span className="auth-illu__ring-dot" style={{ width: 8, height: 8, background: '#1B1A17' }} />
          </div>
          <div className="auth-illu__ring" style={{ width: '50%', height: '50%', border: '1.5px dashed rgba(75,83,39,.32)', '--dur': '26s' }}>
            <span className="auth-illu__ring-dot" style={{ width: 7, height: 7, background: '#C7BE9F' }} />
          </div>

          <div className="auth-illu__core">
            <CoreSpark />
          </div>

          <div className="auth-illu__bubble auth-illu__bubble--dark" style={{ top: '6%', right: '10%' }}>
            <span className="auth-illu__dot" />
            <span className="auth-illu__dot" />
            <span className="auth-illu__dot" />
          </div>
          <div className="auth-illu__bubble auth-illu__bubble--light" style={{ bottom: '8%', left: '-4%' }}>
            <span className="auth-illu__bar" style={{ width: 56, background: 'rgba(27,26,23,.16)' }} />
            <span className="auth-illu__bar" style={{ width: 36, background: 'rgba(108,122,70,.45)' }} />
          </div>

          <Spark size={20} color="#6C7A46" style={{ left: '2%', top: '0%' }} delay="0.3s" />
          <Spark size={15} color="#1B1A17" style={{ right: '6%', bottom: '16%' }} delay="1.4s" />
        </div>
      </div>

      {/* Cluster derecho: conversación flotante */}
      <div className="auth-illu__cluster auth-illu__cluster--right">
        <div className="auth-illu__stage auth-illu__stage--right">
          <div style={{ position: 'absolute', top: '6%', left: '52%', transform: 'translateX(-50%)', width: '60%', aspectRatio: '1 / 1' }}>
            <div className="auth-illu__ring is-reverse" style={{ width: '100%', height: '100%', border: '1.5px dashed rgba(75,83,39,.24)', '--dur': '30s' }}>
              <span className="auth-illu__ring-dot" style={{ width: 7, height: 7, background: '#6C7A46' }} />
            </div>
          </div>

          <div className="auth-illu__bubble auth-illu__bubble--dark" style={{ top: '16%', right: '6%' }}>
            <span className="auth-illu__dot" />
            <span className="auth-illu__dot" />
            <span className="auth-illu__dot" />
          </div>
          <div className="auth-illu__bubble auth-illu__bubble--light" style={{ bottom: '20%', left: '16%' }}>
            <span className="auth-illu__bar" style={{ width: 60, background: 'rgba(27,26,23,.16)' }} />
            <span className="auth-illu__bar" style={{ width: 40, background: 'rgba(108,122,70,.45)' }} />
          </div>

          <Spark size={18} color="#6C7A46" style={{ right: '2%', top: '52%' }} delay="0.9s" />
          <Spark size={14} color="#C7BE9F" style={{ left: '8%', bottom: '2%' }} delay="1.9s" />
        </div>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const [params] = useSearchParams();
  const initialMode = params.get('mode') === 'register' ? 'register' : 'login';
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
        navigate('/', { replace: true });
      } else if (mode === 'register') {
        if (password !== confirm) {
          setError('Las contraseñas no coinciden');
          return;
        }
        await register({ firstName, lastName, email, password });
        navigate('/', { replace: true });
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
      <AuthIllustration />

      <Link to="/" className="auth__logo" aria-label="Volver al chat">
        <Logo size={28} />
      </Link>

      <form className="auth__card" onSubmit={handleSubmit}>
        {mode !== 'forgot' && (
          <div className="auth__toggle" role="tablist" data-mode={mode}>
            <span className="auth__toggle-thumb" aria-hidden="true" />
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'is-active' : ''}
              onClick={() => switchMode('login')}
            >
              Iniciar Sesion
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'is-active' : ''}
              onClick={() => switchMode('register')}
            >
              Registrarse
            </button>
          </div>
        )}

        {/* key={mode}: remonta el bloque para animar la entrada al cambiar de modo */}
        <div className="auth__fields" key={mode}>
          {mode === 'forgot' && (
            <h1 className="auth__title">Restablecer contraseña</h1>
          )}

          {mode === 'register' && (
            <div className="auth__row">
              <FloatingField label="Nombre" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
              <FloatingField label="Apellido" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </div>
          )}

          <FloatingField label="Correo Electronico" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />

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
              label="Confirmar Contraseña"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
            />
          )}

          {error && <p className="auth__error" role="alert">{error}</p>}
          {notice && <p className="auth__notice">{notice}</p>}

          <button className="pill-btn pill-btn--primary auth__cta" type="submit" disabled={busy}>
            {mode === 'login' && (busy ? 'Iniciando…' : 'Iniciar Sesion')}
            {mode === 'register' && (busy ? 'Creando cuenta…' : 'Crear Cuenta')}
            {mode === 'forgot' && (busy ? 'Enviando…' : 'Enviar enlace')}
          </button>

          {mode === 'login' && (
            <button type="button" className="auth__link" onClick={() => switchMode('forgot')}>
              ¿Olvidaste tú contraseña?
            </button>
          )}
          {mode === 'forgot' && (
            <button type="button" className="auth__link" onClick={() => switchMode('login')}>
              Volver a iniciar sesión
            </button>
          )}

          {/* OAuth: solo visual por ahora (sin funcionalidad) */}
          {mode !== 'forgot' && (
            <>
              <div className="auth__divider">
                <span>{mode === 'login' ? 'O inicia sesion con' : 'O registrate con'}</span>
              </div>
              <div className="auth__social">
                <button type="button" className="auth__social-btn auth__social-btn--google">
                  <GoogleLogo /> Google
                </button>
                <button type="button" className="auth__social-btn auth__social-btn--apple">
                  <AppleLogo /> Apple
                </button>
              </div>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
