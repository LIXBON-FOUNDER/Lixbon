// AuthPage.jsx — acceso y registro sobre el fondo del clúster.
// Incluye el modo "olvidé mi contraseña" (request-password-reset).
// Google y GitHub: PKCE contra core/gateway/routers/oauth.py; el verificador
// se queda en sessionStorage y el navegador solo lleva su hash.
import { useSeo } from '../lib/seo';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useT } from '../i18n/useT';
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

function GitHubLogo() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="#141414" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

const OAUTH_KEY = 'lixbon_oauth';
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function empezarOAuth(provider, next) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, next }));
  const q = new URLSearchParams({ redirect_uri: `${window.location.origin}${window.location.pathname}`, code_challenge: challenge });
  window.location.assign(`/api/auth/oauth/${provider}/start?${q}`);
}

export default function AuthPage() {
  const t = useT('auth');
  useSeo({ title: t('seoLogin'), noindex: true });
  const [params] = useSearchParams();
  const initialMode = params.get('mode') === 'register' ? 'register' : 'login';
  // Vuelta post-login (p.ej. /remote/<token> desde el QR). Solo rutas internas:
  // un next externo sería un open-redirect.
  const rawNext = params.get('next') || '';
  const nextPath = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/chat';
  const [mode, setMode] = useState(initialMode); // 'login' | 'register' | 'forgot'
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, register, setUser } = useAuth();
  const [providers, setProviders] = useState([]);
  const [oauthBusy, setOauthBusy] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/api/auth/oauth/providers').then((res) => setProviders(res.data.providers || [])).catch(() => {});
  }, []);

  // Vuelta del proveedor: ?lixbon_code=… se canjea con el verificador guardado.
  useEffect(() => {
    const code = params.get('lixbon_code');
    const fallo = params.get('lixbon_error');
    if (!code && !fallo) return;
    let guardado = {};
    try { guardado = JSON.parse(sessionStorage.getItem(OAUTH_KEY) || '{}'); } catch { /* vacío */ }
    sessionStorage.removeItem(OAUTH_KEY);
    window.history.replaceState(null, '', window.location.pathname);
    if (fallo || !guardado.verifier) {
      setError(fallo ? t('oauthCancelled') : t('genericError'));
      return;
    }
    setOauthBusy('exchange');
    api.post('/api/auth/oauth/exchange', { code, code_verifier: guardado.verifier })
      .then(async (res) => {
        setUser(res.data.user);
        api.get('/api/auth/me').then((me) => setUser(me.data.user)).catch(() => {});
        const next = typeof guardado.next === 'string' && guardado.next.startsWith('/') && !guardado.next.startsWith('//') ? guardado.next : '/chat';
        navigate(next, { replace: true });
      })
      .catch((err) => setError(err.response?.data?.detail || t('genericError')))
      .finally(() => setOauthBusy(''));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const conProveedor = async (provider) => {
    setError('');
    setOauthBusy(provider);
    try {
      await empezarOAuth(provider, nextPath);
    } catch {
      setOauthBusy('');
      setError(t('genericError'));
    }
  };

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
          setError(t('passwordsDontMatch'));
          return;
        }
        await register({ firstName, lastName, email, password });
        navigate(nextPath, { replace: true });
      } else {
        await api.post('/api/auth/request-password-reset', { email });
        setNotice(t('resetLinkNotice'));
      }
    } catch (err) {
      setError(err.response?.data?.detail || t('genericError'));
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
            <Link to="/" className="auth__logo" aria-label={t('home')}>
              <Logo />
            </Link>
            <h1 className="auth__title">{t(`titles.${mode}`)}</h1>
          </div>

          {/* key={mode}: remonta el bloque para animar la entrada al cambiar de modo */}
          <div className="auth__fields" key={mode}>
            {mode === 'register' && (
              <div className="auth__row">
                <FloatingField label={t('firstName')} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
                <FloatingField label={t('lastName')} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
              </div>
            )}

            <FloatingField
              label={t('email')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder={t('emailPlaceholder')}
            />

            {mode !== 'forgot' && (
              <FloatingField
                label={t('password')}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
              />
            )}

            {mode === 'register' && (
              <FloatingField
                label={t('confirmPassword')}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
              />
            )}

            {mode === 'login' && (
              <button type="button" className="auth__link auth__link--right" onClick={() => switchMode('forgot')}>
                {t('forgotPassword')}
              </button>
            )}
          </div>

          {error && <p className="auth__error" role="alert">{error}</p>}
          {notice && <p className="auth__notice">{notice}</p>}

          <div className="auth__actions">
            <button className="auth__cta" type="submit" disabled={busy}>
              {mode === 'login' && (busy ? t('loggingIn') : t('login'))}
              {mode === 'register' && (busy ? t('creatingAccount') : t('createAccount'))}
              {mode === 'forgot' && (busy ? t('sending') : t('sendLink'))}
            </button>

            {mode === 'login' && (
              <p className="auth__switch">
                {t('noAccount')}{' '}
                <button type="button" onClick={() => switchMode('register')}>{t('signUp')}</button>
              </p>
            )}
            {mode === 'register' && (
              <p className="auth__switch auth__legal">
                {t('legalNoticeBefore')} <Link to="/legal/terms">{t('terms')}</Link> {t('legalNoticeMiddle')}{' '}
                <Link to="/legal/privacy">{t('privacyPolicy')}</Link>.
              </p>
            )}
            {mode === 'register' && (
              <p className="auth__switch">
                {t('haveAccount')}{' '}
                <button type="button" onClick={() => switchMode('login')}>{t('logIn')}</button>
              </p>
            )}
            {mode === 'forgot' && (
              <p className="auth__switch">
                <button type="button" onClick={() => switchMode('login')}>{t('backToLogin')}</button>
              </p>
            )}
          </div>

          {mode !== 'forgot' && providers.length > 0 && (
            <>
              <div className="auth__divider"><span>{t('or')}</span></div>
              <div className="auth__social">
                {providers.includes('google') && (
                  <button type="button" className="auth__social-btn" onClick={() => conProveedor('google')} disabled={!!oauthBusy}>
                    <GoogleLogo /> {t('google')}
                  </button>
                )}
                {providers.includes('github') && (
                  <button type="button" className="auth__social-btn" onClick={() => conProveedor('github')} disabled={!!oauthBusy}>
                    <GitHubLogo /> {oauthBusy === 'exchange' ? t('oauthWorking') : t('github')}
                  </button>
                )}
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
