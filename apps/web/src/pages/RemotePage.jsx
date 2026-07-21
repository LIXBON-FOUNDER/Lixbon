// RemotePage.jsx — control remoto desde la web.
//   /remote/:token → llegada por el link/QR de /remote; el token solo
//                    identifica la sesión: SIEMPRE exige iniciar sesión con la
//                    cuenta dueña (sin sesión web → /auth?next=… y vuelve)
//   /remote        → lista de sesiones del usuario con sesión iniciada
// Transcript en vivo (SSE), envío de prompts, interrupción y aprobaciones.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { initialRemoteState, openEventStream, remoteReducer } from '../lib/remote';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';

const SOURCE_LABEL = { cli: 'CLI', ide: 'IDE' };

export default function RemotePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState(!!token);

  // Con token (QR/link): resolverlo a su sesión. El gateway exige estar
  // autenticado como el dueño; sin sesión web se pasa por /auth y se vuelve.
  useEffect(() => {
    if (!token) return;
    api.post('/api/remote/claim', { token })
      .then((res) => {
        setSession(res.data.session);
        setClaiming(false);
      })
      .catch((err) => {
        if (err.response?.status === 401) {
          navigate(`/auth?next=${encodeURIComponent(`/remote/${token}`)}`, { replace: true });
          return;
        }
        setError('Este link no existe, expiró, fue revocado o no pertenece a tu cuenta.');
        setClaiming(false);
      });
  }, [token, navigate]);

  return (
    <div className="page page--cream remote-page">
      <header className="pubnav">
        <Link to="/" className="pubnav__logo"><Logo size={30} /></Link>
        <span className="shared__badge">Control remoto</span>
        <div className="pubnav__actions">
          <Link to="/" className="pill-btn pill-btn--primary pubnav__btn">Ir al chat</Link>
        </div>
      </header>

      {claiming ? (
        <main className="remote__center"><span className="remote__dim">Conectando…</span></main>
      ) : error ? (
        <main className="remote__center"><p className="page__error" role="alert">{error}</p></main>
      ) : session ? (
        <RemoteSession session={session} onExit={() => setSession(null)} />
      ) : (
        <RemoteList onOpen={setSession} />
      )}
    </div>
  );
}

// ── Lista (usuario con sesión web) ──────────────────────────────────────────

function RemoteList({ onOpen }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/remote/sessions')
      .then((res) => { if (alive) setSessions(res.data.sessions || []); })
      .catch((err) => {
        if (!alive) return;
        if (err.response?.status === 401) setError('Inicia sesión para ver tus sesiones remotas.');
        else setError('No se pudieron cargar las sesiones.');
      });
    load();
    const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (error) {
    return (
      <main className="remote__center">
        <p className="remote__dim">{error}</p>
        <Link to="/auth" className="pill-btn pill-btn--primary">Iniciar sesión</Link>
      </main>
    );
  }
  if (!sessions) return <main className="remote__center"><span className="remote__dim">Cargando…</span></main>;
  if (!sessions.length) {
    return (
      <main className="remote__center">
        <h1 className="remote__empty-title">Sin sesiones remotas</h1>
        <p className="remote__dim">
          Ejecuta <code>/remote</code> en el IDE o el CLI de Lixbon y la sesión aparecerá aquí.
        </p>
      </main>
    );
  }
  return (
    <main className="remote__list">
      {sessions.map((s) => (
        <button
          key={s.id}
          className="remote__card"
          disabled={s.status === 'ended'}
          onClick={() => onOpen(s)}
        >
          <span className={`remote__dot ${s.status === 'online' ? 'is-online' : ''}`} />
          <span className="remote__card-body">
            <strong>{s.title || 'Sesión remota'}</strong>
            <span className="remote__dim">
              {s.machine || '—'} · {s.status === 'ended' ? 'terminada' : s.status === 'online' ? 'en línea' : 'sin conexión'}
            </span>
          </span>
          <span className="remote__badge">{SOURCE_LABEL[s.source] || s.source}</span>
        </button>
      ))}
    </main>
  );
}

// ── Sesión en vivo ──────────────────────────────────────────────────────────

function RemoteSession({ session }) {
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [input, setInput] = useState('');
  const seqRef = useRef(0);
  const threadRef = useRef(null);

  useEffect(() => { seqRef.current = state.lastSeq; }, [state.lastSeq]);

  // Auto-scroll al fondo con cada evento nuevo.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items, state.approvals]);

  useEffect(() => {
    const abort = new AbortController();
    let backoff = 2000;
    let alive = true;
    const connect = async () => {
      while (alive) {
        try {
          await openEventStream({
            path: `/api/remote/sessions/${session.id}/stream?from_seq=${seqRef.current}`,
            signal: abort.signal,
            onEvent: (ev) => { backoff = 2000; dispatch(ev); },
          });
        } catch (err) {
          if (!alive || abort.signal.aborted) return;
          if (err.status === 404 || err.status === 410) {
            dispatch({ type: 'session_ended' });
            return;
          }
        }
        if (!alive) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    };
    connect();
    return () => { alive = false; abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const sendCommand = useCallback((command) => {
    return api.post(`/api/remote/sessions/${session.id}/commands`, command).catch(() => {});
  }, [session.id]);

  const sendPrompt = (e) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || state.ended || !state.hostConnected) return;
    sendCommand({ type: 'prompt', text });
    setInput('');
  };

  const title = state.meta?.title || session.title || 'Sesión remota';
  const statusLabel = state.ended
    ? 'Sesión terminada'
    : !state.hostConnected
      ? 'Host sin conexión…'
      : state.agentState === 'thinking'
        ? 'El agente está trabajando…'
        : 'Conectado';

  return (
    <main className="remote__session">
      <div className="remote__head">
        <div>
          <h1 className="remote__title">{title}</h1>
          <p className={`remote__dim ${state.ended ? 'remote__dim--danger' : ''}`}>
            {SOURCE_LABEL[state.meta?.source || session.source] || ''}
            {state.meta?.machine ? ` · ${state.meta.machine}` : ''}
            {' · '}{statusLabel}
          </p>
        </div>
        <span className={`remote__dot remote__dot--lg ${state.hostConnected && !state.ended ? 'is-online' : ''}`} />
      </div>

      <div className="remote__thread" ref={threadRef}>
        {state.items.map((item) => {
          if (item.kind === 'user') {
            return <div key={item.key} className="msg msg--user">{item.text}</div>;
          }
          if (item.kind === 'tool') {
            return (
              <div key={item.key} className={`remote__tool ${item.error ? 'is-error' : ''}`}>
                <span className="remote__tool-name">{item.tool}</span>
                {item.summary && <span className="remote__tool-summary">{item.summary}</span>}
                <span className="remote__tool-state">
                  {item.running ? '…' : item.error ? 'falló' : 'ok'}
                </span>
              </div>
            );
          }
          if (item.kind === 'error') {
            return <div key={item.key} className="remote__error">{item.text}</div>;
          }
          return (
            <div key={item.key} className="msg msg--assistant">
              {item.text
                ? <Markdown>{item.text}</Markdown>
                : item.open ? <span className="remote__dim">Pensando…</span> : null}
            </div>
          );
        })}
        {!state.items.length && (
          <p className="remote__dim remote__hint">
            {state.hostConnected
              ? 'Sesión conectada. Escribe abajo para pedirle algo al agente.'
              : 'Esperando al host…'}
          </p>
        )}
      </div>

      {state.approvals.map((a) => (
        <div key={a.id} className="remote__approval">
          <p>
            <strong>{a.risk === 'command' ? 'El agente quiere ejecutar un comando' : 'El agente quiere aplicar un cambio'}</strong>
          </p>
          <code>{a.tool}{a.summary ? `  ${a.summary}` : ''}</code>
          <div className="remote__approval-actions">
            <button className="pill-btn pill-btn--outline" onClick={() => sendCommand({ type: 'approve', id: a.id, decision: 'deny' })}>
              Denegar
            </button>
            <button className="pill-btn pill-btn--primary" onClick={() => sendCommand({ type: 'approve', id: a.id, decision: 'allow' })}>
              Permitir
            </button>
          </div>
        </div>
      ))}

      <form className="remote__composer" onSubmit={sendPrompt}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={state.ended ? 'La sesión terminó' : state.hostConnected ? 'Pídele algo al agente…' : 'Host sin conexión…'}
          disabled={state.ended || !state.hostConnected}
        />
        {state.agentState === 'thinking' && !state.ended ? (
          <button type="button" className="pill-btn pill-btn--outline" onClick={() => sendCommand({ type: 'interrupt' })}>
            Detener
          </button>
        ) : (
          <button type="submit" className="pill-btn pill-btn--primary" disabled={!input.trim() || state.ended || !state.hostConnected}>
            Enviar
          </button>
        )}
      </form>
    </main>
  );
}
