// ResetPasswordPage.jsx — establece la nueva contraseña desde el enlace del
// email (/reset-password?token=...). El backend rota las API keys al cambiarla.
import { useSeo } from '../lib/seo';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { FloatingField } from '../components/FloatingField';
import { Logo } from '../components/Logo';
import { ClusterFondo } from '../components/ClusterFondo';
import { api } from '../lib/api';

export default function ResetPasswordPage() {
  const t = useT('auth');
  useSeo({ title: t('resetSeoTitle'), noindex: true });
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
      setError(t('passwordsDontMatch'));
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, new_password: password });
      navigate('/auth?reset=1', { replace: true });
    } catch (err) {
      setError(err.response?.data?.detail || t('resetFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="auth">
        <ClusterFondo />
        <div className="auth__panel">
          <span className="tab" aria-hidden="true" />
          <div className="auth__card">
            <div className="auth__head">
              <Link to="/" className="auth__logo"><Logo /></Link>
              <h1 className="auth__title">{t('invalidLinkTitle')}</h1>
            </div>
            <p className="auth__notice">{t('invalidLinkNotice')}</p>
            <Link className="auth__cta" to="/auth">{t('goToLogin')}</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <ClusterFondo />
      <div className="auth__panel">
        <span className="tab" aria-hidden="true" />
        <form className="auth__card" onSubmit={handleSubmit}>
          <div className="auth__head">
            <Link to="/" className="auth__logo"><Logo /></Link>
            <h1 className="auth__title">{t('newPasswordTitle')}</h1>
          </div>
          <div className="auth__fields">
            <FloatingField label={t('newPassword')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} />
            <FloatingField label={t('confirmPassword')} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} />
          </div>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <div className="auth__actions">
            <button className="auth__cta" type="submit" disabled={busy}>
              {busy ? t('saving') : t('savePassword')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
