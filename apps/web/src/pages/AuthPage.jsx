// AuthPage.jsx — login/registro con toggle segmentado (mockups 2.3 y 2.4).
// Incluye el modo "olvidé mi contraseña" (request-password-reset).
// Botones OAuth Google/Apple: OCULTOS por decisión de producto (post-F4).
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { FloatingField } from '../components/FloatingField';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';

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
      <Link to="/" className="auth__logo" aria-label="Volver al chat">
        <Logo size={26} />
      </Link>

      <form className="auth__card" onSubmit={handleSubmit}>
        {mode !== 'forgot' && (
          <div className="auth__toggle" role="tablist">
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

        {/* OAuth Google/Apple: pendiente de decisión de producto — oculto en v1 */}
      </form>
    </div>
  );
}
