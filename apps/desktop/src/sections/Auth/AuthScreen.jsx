// AuthScreen.jsx — entrada de la app: GitHub o Google, la cuenta de
// lixbon.com (email o el navegador del sistema) o una API key lixbon_sk_.
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { DEFAULT_SERVER_URL } from '../../lib/settings';
import { openExternal } from '../../lib/tauri';
import { browserLogin, oauthLogin, oauthProviders, PROVIDER_NAMES } from '../../lib/browserLogin';
import { LogoMark } from '../../components/Logo';
import { SpinRing } from '../../components/Ring';
import { IconEye, IconEyeOff, IconGlobe } from '../../components/Icons';
import '../../styles/auth.css';

function GitHubLogo() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.4c-.5 2.9-2.1 5.4-4.6 7l7.6 5.9c4.4-4.1 6.7-10.1 6.7-17.2Z" />
      <path fill="#FBBC05" d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1Z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.4 0-11.7-3.7-13.6-9.9l-7.8 6.1C6.5 42.6 14.6 48 24 48Z" />
    </svg>
  );
}

const PROVIDER_LOGOS = { github: GitHubLogo, google: GoogleLogo };

function normalizeUrl(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

const NO_SERVER = 'No se pudo conectar con el servidor. Revisa tu conexión o la URL en opciones avanzadas.';

async function loginWithEmail(serverUrl, email, password) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // issue_api_key: el servidor entrega una API key propia de la app en la
      // respuesta. La cookie de sesión no sirve aquí: es SameSite=Lax y no se
      // envía en peticiones cross-origin desde tauri://localhost.
      body: JSON.stringify({ email, password, issue_api_key: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(NO_SERVER);
  }

  if (res.status === 401) throw new Error('Correo o contraseña incorrectos.');
  if (!res.ok) throw new Error(`El servidor respondió con un error (${res.status}).`);

  const body = await res.json();
  const apiKey = body.api_key || '';
  if (!apiKey) throw new Error('El servidor no entregó una API key para esta app. Inténtalo de nuevo.');

  const user = await fetchProfile(serverUrl, apiKey);
  return { apiKey, user: user || body.user };
}

async function fetchProfile(serverUrl, apiKey) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(NO_SERVER);
  }
  if (res.status === 401) throw new Error('La API key no es válida o fue revocada.');
  if (!res.ok) throw new Error(`El servidor respondió con un error (${res.status}).`);
  return (await res.json()).user;
}

export function AuthScreen() {
  const { serverUrl, setServerUrl, setApiKey, setUser } = useAppStore();

  const [mode, setMode] = useState('login'); // 'login' | 'key'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(null); // 'browser' | 'github' | 'google'
  const [providers, setProviders] = useState([]);
  const browserAbort = useRef(null);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [urlInput, setUrlInput] = useState(serverUrl || DEFAULT_SERVER_URL);
  const [urlStatus, setUrlStatus] = useState(null); // { ok, text }

  const effectiveUrl = () => normalizeUrl(urlInput) || DEFAULT_SERVER_URL;
  const serverForProviders = effectiveUrl();

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => oauthProviders(serverForProviders).then((p) => alive && setProviders(p)), 300);
    return () => { alive = false; clearTimeout(t); };
  }, [serverForProviders]);

  const enter = (url, session) => {
    setServerUrl(url);
    setUser(session.user);
    setApiKey(session.apiKey); // último: dispara la entrada a la app
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    const url = effectiveUrl();
    try {
      let session;
      if (mode === 'login') {
        session = await loginWithEmail(url, email.trim(), password);
      } else {
        const key = keyInput.trim();
        if (!key.startsWith('lixbon_sk_')) {
          throw new Error('Las API keys de lixbon empiezan por lixbon_sk_. Cópiala completa desde la web.');
        }
        session = { apiKey: key, user: await fetchProfile(url, key) };
      }
      enter(url, session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const viaBrowser = async (kind) => {
    if (waiting) {
      browserAbort.current?.abort();
      if (waiting === kind) return;
    }
    setError('');
    setWaiting(kind);
    const ctrl = new AbortController();
    browserAbort.current = ctrl;
    const url = effectiveUrl();
    try {
      const session = kind === 'browser' ? await browserLogin(url, ctrl.signal) : await oauthLogin(url, kind, ctrl.signal);
      enter(url, session);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (browserAbort.current === ctrl) setWaiting(null);
    }
  };

  const handleTestUrl = async () => {
    const url = effectiveUrl();
    setUrlStatus({ ok: null, text: 'Comprobando…' });
    const start = performance.now();
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        setUrlStatus({ ok: true, text: `Conectado (${Math.round(performance.now() - start)} ms)` });
      } else {
        setUrlStatus({ ok: false, text: `El servidor respondió ${res.status}.` });
      }
    } catch {
      setUrlStatus({ ok: false, text: 'No se pudo conectar con esa URL.' });
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError('');
  };

  return (
    <div className="auth">
      <aside className="auth__brand">
        <span className="auth__glow" />
        <span className="auth__glow auth__glow--2" />
        <div className="auth__wordmark"><LogoMark size={22} /><span className="brand">lixbon</span></div>
        <span className="auth__bigmark"><LogoMark size={240} /></span>
        <div className="auth__pitch rise">
          <span className="auth__headline">Tu agente, tu código y tu diseño en un solo lugar.</span>
          <span className="auth__lede">Modelos del clúster lixbon con la misma cuenta que usas en la web, el CLI y el móvil.</span>
        </div>
        <span className="mono auth__modes rise rise--1">agente · editor · diseño · git</span>
      </aside>

      <main className="auth__main">
        <form className="auth__card" onSubmit={handleSubmit}>
          <div className="auth__title rise">
            <span className="auth__h1">Iniciar sesión</span>
            <span className="auth__sub">Entra con tu cuenta de lixbon.com</span>
          </div>

          {providers.length > 0 && (
            <>
              <div className="auth__social rise rise--1">
                {providers.map((p) => {
                  const Logo = PROVIDER_LOGOS[p];
                  return (
                    <button key={p} type="button" className="btn btn--ghost auth__cta auth__social-btn" onClick={() => viaBrowser(p)} disabled={busy}>
                      {waiting === p ? <SpinRing size={14} /> : <Logo />}
                      {waiting === p ? 'Esperando · Cancelar' : `Continuar con ${PROVIDER_NAMES[p]}`}
                    </button>
                  );
                })}
              </div>
              <div className="auth__or rise rise--1"><span>o con tu cuenta de lixbon</span></div>
            </>
          )}

          <div className="seg auth__seg rise rise--1">
            <span className="seg__thumb auth__segthumb" style={{ transform: mode === 'key' ? 'translateX(100%)' : 'none' }} />
            <button type="button" className={`seg__opt ${mode === 'login' ? 'is-active' : ''}`} onClick={() => switchMode('login')}>Email</button>
            <button type="button" className={`seg__opt ${mode === 'key' ? 'is-active' : ''}`} onClick={() => switchMode('key')}>Clave de API</button>
          </div>

          {mode === 'login' ? (
            <div className="auth__fields" key="login">
              <label className="fieldlabel">
                Email
                <div className="field field--strong auth__field">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
                </div>
              </label>
              <label className="fieldlabel">
                <span className="auth__pwlabel">
                  Contraseña
                  <button type="button" className="lk" onClick={() => openExternal(`${effectiveUrl()}/auth`)}>¿La olvidaste?</button>
                </span>
                <div className="field field--strong auth__field">
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                  <button type="button" className="ic" onClick={() => setShowPw(!showPw)} aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                    {showPw ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </button>
                </div>
              </label>
            </div>
          ) : (
            <div className="auth__fields" key="key">
              <label className="fieldlabel">
                Clave de API
                <div className="field field--strong auth__field">
                  <input className="mono" type="password" value={keyInput} placeholder="lixbon_sk_…" onChange={(e) => setKeyInput(e.target.value)} autoComplete="off" spellCheck={false} required autoFocus />
                </div>
              </label>
              <span className="auth__hint">Créala en lixbon.com → Cuenta → Claves de API. Se valida y se guarda en este equipo.</span>
            </div>
          )}

          {error && <p className="spage__error">{error}</p>}

          <div className="auth__actions rise rise--2">
            <button type="submit" className="btn btn--primary auth__cta" disabled={busy || !!waiting}>
              {busy && <SpinRing size={14} color="var(--on-primary)" />}
              {busy ? 'Entrando' : mode === 'login' ? 'Iniciar sesión' : 'Conectar'}
            </button>
            <button type="button" className="btn btn--ghost auth__cta" onClick={() => viaBrowser('browser')} disabled={busy}>
              {waiting === 'browser' ? <SpinRing size={14} /> : <IconGlobe size={15} />}
              {waiting === 'browser' ? 'Esperando al navegador · Cancelar' : 'Continuar con el navegador'}
            </button>
          </div>

          <span className="auth__signup rise rise--3">
            ¿No tienes cuenta?{' '}
            <button type="button" className="lk is-accent" onClick={() => openExternal(`${effectiveUrl()}/auth?mode=register`)}>Créala en lixbon.com</button>
          </span>

          <button type="button" className={`lk auth__advtoggle ${advancedOpen ? 'is-open' : ''}`} onClick={() => setAdvancedOpen(!advancedOpen)}>
            Opciones avanzadas
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <div className={`reveal ${advancedOpen ? 'is-open' : ''}`}>
            <div className="reveal__inner">
              <div className="auth__advanced">
                <div className="field field--strong auth__field">
                  <input className="mono" value={urlInput} onChange={(e) => { setUrlInput(e.target.value); setUrlStatus(null); }} placeholder="URL del servidor" spellCheck={false} />
                  <button type="button" className="lk" onClick={handleTestUrl}>Probar</button>
                </div>
                {urlStatus && (
                  <span className={`auth__urlstatus ${urlStatus.ok === true ? 'is-ok' : urlStatus.ok === false ? 'is-error' : ''}`}>{urlStatus.text}</span>
                )}
              </div>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
