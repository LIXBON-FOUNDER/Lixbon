// ResetPasswordPage.jsx — establece la nueva contraseña desde el enlace del
// email (/reset-password?token=...). El backend rota las API keys al cambiarla.
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { FloatingField } from '../components/FloatingField';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, new_password: password });
      navigate('/auth?reset=1', { replace: true });
    } catch (err) {
      setError(err.response?.data?.detail || 'No se pudo restablecer la contraseña.');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="auth">
        <Link to="/" className="auth__logo"><Logo size={26} /></Link>
        <div className="auth__card">
          <h1 className="auth__title">Enlace inválido</h1>
          <p className="auth__notice">Este enlace no es válido. Solicita uno nuevo desde el inicio de sesión.</p>
          <Link className="pill-btn pill-btn--primary auth__cta" to="/auth">Ir a iniciar sesión</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <Link to="/" className="auth__logo"><Logo size={26} /></Link>
      <form className="auth__card" onSubmit={handleSubmit}>
        <h1 className="auth__title">Nueva contraseña</h1>
        <FloatingField label="Nueva Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} />
        <FloatingField label="Confirmar Contraseña" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} />
        {error && <p className="auth__error" role="alert">{error}</p>}
        <button className="pill-btn pill-btn--primary auth__cta" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </form>
    </div>
  );
}
