// AuthScreen.jsx — entrada única de la app: iniciar sesión con la cuenta
// de la web (email) o pegar una API key LIXBON_sk_ creada allí.
import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { DEFAULT_SERVER_URL } from '../../lib/settings';
import { openExternal } from '../../lib/tauri';
import { Logo } from '../../components/Logo';
import { FloatingField } from '../../components/FloatingField';
import '../../styles/auth.css';

function normalizeUrl(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** Valida credenciales contra el gateway y devuelve { apiKey, user }. */
async function loginWithEmail(serverUrl, email, password) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      credentials: 'include', // conserva la cookie LIXBON_session para crear la key
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión o la URL en opciones avanzadas.');
  }

  if (res.status === 401) throw new Error('Correo o contraseña incorrectos.');
  if (!res.ok) throw new Error(`El servidor respondió con un error (${res.status}).`);

  const body = await res.json();
  let apiKey = body.api_key || '';

  // Si el usuario ya tenía keys activas, el login no devuelve ninguna:
  // se crea una key propia de la app usando la sesión recién abierta.
  if (!apiKey) {
    const keyRes = await fetch(`${serverUrl}/api/keys`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'LIXBON Desktop' }),
      signal: AbortSignal.timeout(15000),
    });
    if (keyRes.status === 403) {
      const err = await keyRes.json().catch(() => ({}));
      throw new Error(
        err?.detail?.message ||
        'Tu plan no permite más API keys. Elimina una en la web o pega aquí una existente.'
      );
    }
    if (!keyRes.ok) throw new Error('No se pudo crear una API key para esta app.');
    apiKey = (await keyRes.json()).api_key;
  }

  const user = await fetchProfile(serverUrl, apiKey);
  return { apiKey, user: user || body.user };
}

/** Valida una API key y devuelve el usuario con su plan, o lanza error. */
async function fetchProfile(serverUrl, apiKey) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión o la URL en opciones avanzadas.');
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
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [urlInput, setUrlInput] = useState(serverUrl || DEFAULT_SERVER_URL);
  const [urlStatus, setUrlStatus] = useState(null); // { ok, text }

  const effectiveUrl = () => normalizeUrl(urlInput) || DEFAULT_SERVER_URL;

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
        if (!key.startsWith('LIXBON_sk_')) {
          throw new Error('Las API keys de LIXBON empiezan por LIXBON_sk_. Cópiala completa desde la web.');
        }
        session = { apiKey: key, user: await fetchProfile(url, key) };
      }
      setServerUrl(url);
      setUser(session.user);
      setApiKey(session.apiKey); // último: dispara la entrada a la app
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
      <div className="auth__logo">
        <Logo size={34} />
      </div>

      <form className="auth__card" onSubmit={handleSubmit}>
        <div className="auth__toggle" data-mode={mode}>
          <span className="auth__toggle-thumb" aria-hidden="true" />
          <button
            type="button"
            className={mode === 'login' ? 'is-active' : ''}
            onClick={() => switchMode('login')}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            className={mode === 'key' ? 'is-active' : ''}
            onClick={() => switchMode('key')}
          >
            API key
          </button>
        </div>

        {mode === 'login' ? (
          <div className="auth__fields" key="login">
            <FloatingField
              label="Correo electrónico"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <FloatingField
              label="Contraseña"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
        ) : (
          <div className="auth__fields" key="key">
            <FloatingField
              label="API key (LIXBON_sk_…)"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="auth__hint">
              Crea tu API key en la web, en Cuenta → API keys. Se valida y se guarda en este equipo.
            </p>
          </div>
        )}

        {error && <p className="auth__error">{error}</p>}

        <button type="submit" className="pill-btn pill-btn--primary auth__cta" disabled={busy}>
          {busy ? 'Conectando…' : mode === 'login' ? 'Iniciar sesión' : 'Conectar'}
        </button>

        <button
          type="button"
          className="auth__link"
          onClick={() => openExternal(`${effectiveUrl()}/auth?mode=register`)}
        >
          ¿No tienes cuenta? Regístrate en la web
        </button>

        <button
          type="button"
          className={`auth__advanced-toggle ${advancedOpen ? 'is-open' : ''}`}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          Opciones avanzadas
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <div className={`reveal ${advancedOpen ? 'is-open' : ''}`}>
          <div className="reveal__inner">
            <div className="auth__advanced">
              <FloatingField
                label="URL del servidor"
                type="text"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlStatus(null); }}
                required={false}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="pill-btn pill-btn--outline" onClick={handleTestUrl}>
                Probar conexión
              </button>
              {urlStatus && (
                <p className={`auth__advanced-status ${urlStatus.ok === true ? 'is-ok' : urlStatus.ok === false ? 'is-error' : ''}`}>
                  {urlStatus.text}
                </p>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
