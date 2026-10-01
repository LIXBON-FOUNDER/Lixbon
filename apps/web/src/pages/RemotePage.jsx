// RemotePage.jsx — control remoto desde la web.
//   /remote/:token → llegada por el link/QR de /remote; el token solo
//                    identifica la sesión: SIEMPRE exige iniciar sesión con la
//                    cuenta dueña (sin sesión web → /auth?next=… y vuelve)
//   /remote        → lista de sesiones del usuario con sesión iniciada
// Transcript en vivo (SSE), envío de prompts, interrupción y aprobaciones.
import { TemaBoton } from '../components/TemaBoton';
import { useSeo } from '../lib/seo';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link, useNavigate } from '../i18n/link';
import { useT } from '../i18n/useT';
import { api } from '../lib/api';
import { initialRemoteState, openEventStream, remoteReducer } from '../lib/remote';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { WaveText } from '../components/WaveText';
import { RemoteOrch } from '../components/RemoteOrch';
import { IconChevron, IconClip, IconFile, IconImage, IconSend, IconStop, IconX } from '../components/Icons';
import { useLocale } from '../i18n/LocaleContext';
import { describeRemoteTool, summarizeRemoteTools } from '../lib/toolText';
import {
  contextoDe, esAudioOVideo, esImagen, mensajeDeError, prepararImagen, subirDocumento,
} from '../lib/adjuntos';

const SOURCE_LABEL = { cli: 'CLI', ide: 'IDE' };

export default function RemotePage() {
  const t = useT('remote');
  const tc = useT('common');
  useSeo({ title: t('seoTitle'), noindex: true });
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
        setError(t('claimError'));
        setClaiming(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, navigate]);

  return (
    <div className={`page remote-page ${session ? 'remote-page--session' : ''}`}>
      <header className="pubnav">
        <Link to="/" className="pubnav__logo"><Logo /></Link>
        <span className="shared__badge">{t('badge')}</span>
        <div className="pubnav__actions">
          <TemaBoton />
          <Link to="/chat" className="pill-btn pill-btn--primary pubnav__btn">{tc('goToChat')}</Link>
        </div>
      </header>

      {claiming ? (
        <main className="remote__center"><span className="remote__dim">{t('connecting')}</span></main>
      ) : error ? (
        <main className="remote__center"><p className="page__error" role="alert">{error}</p></main>
      ) : session ? (
        <RemoteSession session={session} onExit={() => setSession(null)} t={t} tc={tc} />
      ) : (
        <RemoteList onOpen={setSession} t={t} tc={tc} />
      )}
    </div>
  );
}

// ── Lista (usuario con sesión web) ──────────────────────────────────────────

function RemoteList({ onOpen, t, tc }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/remote/sessions')
      .then((res) => { if (alive) setSessions(res.data.sessions || []); })
      .catch((err) => {
        if (!alive) return;
        if (err.response?.status === 401) setError(t('listError401'));
        else setError(t('listErrorGeneric'));
      });
    load();
    const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <main className="remote__center">
        <p className="remote__dim">{error}</p>
        <Link to="/auth" className="pill-btn pill-btn--primary">{tc('logIn')}</Link>
      </main>
    );
  }
  if (!sessions) return <main className="remote__center"><span className="remote__dim">{tc('loading')}</span></main>;
  if (!sessions.length) {
    return (
      <main className="remote__center">
        <h1 className="remote__empty-title">{t('emptyTitle')}</h1>
        <p className="remote__dim">
          {t('emptyBodyBefore')} <code>/remote</code> {t('emptyBodyAfter')}
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
          // Una sesión terminada con transcript guardado se abre igual, en
          // modo lectura: la conversación del IDE/CLI no se pierde al cerrar.
          disabled={s.status === 'ended' && !(s.transcript_events > 0)}
          onClick={() => onOpen(s)}
        >
          <span className={`remote__dot ${s.status === 'online' ? 'is-online' : ''}`} />
          <span className="remote__card-body">
            <strong>{s.title || t('defaultSessionTitle')}</strong>
            <span className="remote__dim">
              {s.machine || '—'} ·{' '}
              {s.status === 'ended'
                ? s.transcript_events > 0 ? t('endedWithTranscript') : t('ended')
                : s.status === 'online' ? t('online') : t('offline')}
            </span>
          </span>
          <span className="remote__badge">{SOURCE_LABEL[s.source] || s.source}</span>
        </button>
      ))}
    </main>
  );
}

// ── Actividad del agente: una línea por tramo de herramientas ───────────────

function ToolLine({ items, t, locale }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(null);
  const current = [...items].reverse().find((it) => it.running);
  const failed = items.filter((it) => it.error).length;
  const text = current ? describeRemoteTool(current, locale) : summarizeRemoteTools(items, locale);
  const done = items.filter((it) => !it.running).length;
  return (
    <div className={`actline-group ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className={`actline ${current ? 'is-running' : ''} ${failed && !current ? 'is-err' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t('hideDetail') : t('showDetail')}
      >
        <span className="actline__icon" aria-hidden="true">
          {current ? <span className="actline__pulse" /> : <span className={`actline__mark ${failed ? 'is-err' : ''}`} />}
        </span>
        {current ? <WaveText key={text} text={text} className="actline__text" /> : <span className="actline__text">{text}</span>}
        <span className="actline__meta">
          {current && items.length > 1 && <span className="actline__step">{t('stepOf', { n: done + 1, total: items.length })}</span>}
          {!current && failed > 0 && <span className="actline__fail">{t('failedCount', { n: failed })}</span>}
        </span>
        <span className={`actline__chev ${open ? 'is-open' : ''}`} aria-hidden="true"><IconChevron size={12} /></span>
      </button>
      {open && (
        <div className="actline__detail">
          {items.map((it) => (
            <div key={it.key} className={`actrow ${it.error ? 'is-err' : ''}`}>
              <div className="actrow__line">
                <span className="actrow__name">{describeRemoteTool(it, locale)}</span>
                {it.summary && <code className="actrow__summary">{it.summary}</code>}
                {it.result && (
                  <button type="button" className="actrow__toggle" onClick={() => setShown((k) => (k === it.key ? null : it.key))}>
                    {shown === it.key ? t('hideOutput') : t('output')}
                  </button>
                )}
                <span className="actrow__state">{it.running ? '…' : it.error ? t('toolError') : t('toolOk')}</span>
              </div>
              {shown === it.key && <pre className="actrow__out">{it.result}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Agrupa las herramientas consecutivas para pintarlas como una sola línea. */
function groupItems(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'tool' && last?.kind === 'tools') last.items.push(it);
    else if (it.kind === 'tool') out.push({ kind: 'tools', key: it.key, items: [it] });
    else out.push(it);
  }
  return out;
}

// ── Caja de escritura ───────────────────────────────────────────────────────

const ACCEPT = [
  'image/*',
  '.pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.py,.js,.jsx,.ts,.tsx',
  '.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.log,text/*,application/pdf',
].join(',');
const MAX_ADJUNTOS = 6;
const MENTION_AT_END = /(^|\s)@([^\s@]*)$/;
let siguienteAdjunto = 0;

function RemoteComposer({ state, sendCommand, t, tc }) {
  const [input, setInput] = useState('');
  const [adjuntos, setAdjuntos] = useState([]);
  const [mentions, setMentions] = useState([]);
  const [aviso, setAviso] = useState('');
  const [sending, setSending] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const fileRef = useRef(null);
  const textRef = useRef(null);
  const caps = state.meta?.capabilities || [];
  const canImages = caps.includes('images');
  const canMention = caps.includes('files') && state.hostConnected && !state.ended;
  const disabled = state.ended || !state.hostConnected;
  const thinking = state.agentState === 'thinking' && !state.ended;
  const leyendo = adjuntos.some((a) => a.estado === 'leyendo');
  const listos = adjuntos.filter((a) => a.estado === 'listo');

  // Alto automático hasta un tope.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const mentionQuery = canMention ? (MENTION_AT_END.exec(input)?.[2] ?? null) : null;
  useEffect(() => {
    if (mentionQuery == null) return undefined;
    const timer = setTimeout(() => sendCommand({ type: 'files', query: mentionQuery }, { quiet: true }), 180);
    return () => clearTimeout(timer);
  }, [mentionQuery, sendCommand]);
  const sugerencias = mentionQuery != null && state.files?.query === mentionQuery
    ? state.files.items.filter((f) => !mentions.some((m) => m.path === f.path)).slice(0, 8)
    : [];

  const pickMention = (file) => {
    setInput((cur) => cur.replace(MENTION_AT_END, '$1'));
    setMentions((cur) => (cur.some((m) => m.path === file.path) ? cur : [...cur, file]));
    textRef.current?.focus();
  };

  const añadir = async (files) => {
    setAviso('');
    const lista = [...files];
    if (adjuntos.length + lista.length > MAX_ADJUNTOS) {
      setAviso(t('tooManyFiles', { n: MAX_ADJUNTOS }));
      lista.splice(MAX_ADJUNTOS - adjuntos.length);
    }
    for (const file of lista) {
      if (esAudioOVideo(file)) { setAviso(t('noAudio', { name: file.name })); continue; }
      const imagen = esImagen(file);
      if (imagen && !canImages) { setAviso(t('noImages')); continue; }
      const id = ++siguienteAdjunto;
      setAdjuntos((cur) => [...cur, { id, name: file.name, kind: imagen ? 'image' : 'doc', estado: 'leyendo' }]);
      try {
        const patch = imagen
          ? await prepararImagen(file).then((img) => ({ base64: img.base64, preview: img.dataUrl, mime: 'image/jpeg' }))
          : await subirDocumento(file).then((d) => ({ text: d.text, truncated: d.truncated }));
        setAdjuntos((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch, estado: 'listo' } : a)));
      } catch (err) {
        setAdjuntos((cur) => cur.filter((a) => a.id !== id));
        setAviso(mensajeDeError(err, file.name));
      }
    }
  };

  const enviar = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if ((!text && !listos.length) || disabled || sending || leyendo) return;
    // Un host sin adjuntos solo entiende texto: los documentos van dentro del
    // mensaje, como en el chat.
    const command = caps.includes('attachments')
      ? {
          type: 'prompt',
          text,
          attachments: listos.map((a) => (a.kind === 'image'
            ? { kind: 'image', name: a.name, base64: a.base64, mime: a.mime }
            : { kind: 'doc', name: a.name, text: a.text })),
          mentions: mentions.map(({ name, rel, path }) => ({ name, rel, path })),
        }
      : {
          type: 'prompt',
          text: listos.length
            ? `${listos.filter((a) => a.kind === 'doc').map((a) => contextoDe({ kind: 'doc', filename: a.name, text: a.text })).join('\n\n')}\n\n---\n\n${text || t('analyzeDoc')}`
            : text,
        };
    setSending(true);
    const ok = await sendCommand(command);
    setSending(false);
    if (ok) {
      setInput('');
      setAdjuntos([]);
      setMentions([]);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (sugerencias.length) { e.preventDefault(); pickMention(sugerencias[0]); return; }
      e.preventDefault();
      enviar();
    }
  };

  return (
    <form
      className={`remote__composer chat-input ${arrastrando ? 'is-dropping' : ''}`}
      onSubmit={enviar}
      onDragOver={(e) => { if (!disabled && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setArrastrando(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setArrastrando(false); }}
      onDrop={(e) => { e.preventDefault(); setArrastrando(false); if (!disabled) añadir(e.dataTransfer.files); }}
    >
      {sugerencias.length > 0 && (
        <div className="remote__mentions" role="listbox">
          {sugerencias.map((f) => (
            <button type="button" key={f.path} className="remote__mention" onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}>
              <IconFile size={14} />
              <span className="remote__mention-name">{f.name}</span>
              <span className="remote__mention-rel">{f.rel}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-input__box">
        {(adjuntos.length > 0 || mentions.length > 0) && (
          <div className="chat-input__chips">
            {mentions.map((m) => (
              <span key={m.path} className="attach-chip attach-chip--mention">
                <span className="attach-chip__name">@{m.name}</span>
                <button type="button" className="attach-chip__x" aria-label={t('remove')} onClick={() => setMentions((cur) => cur.filter((x) => x.path !== m.path))}><IconX size={12} /></button>
              </span>
            ))}
            {adjuntos.map((a) => (
              <span key={a.id} className={a.estado === 'leyendo' ? 'attach-chip is-loading' : 'attach-chip'}>
                {a.preview ? <img className="attach-chip__thumb" src={a.preview} alt="" /> : a.kind === 'image' ? <IconImage size={14} /> : <IconFile size={14} />}
                <span className="attach-chip__name">{a.name}</span>
                <button type="button" className="attach-chip__x" aria-label={t('remove')} onClick={() => setAdjuntos((cur) => cur.filter((x) => x.id !== a.id))}><IconX size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {aviso && <div className="chat-input__error">{aviso}</div>}
        <textarea
          ref={textRef}
          rows={1}
          className="chat-input__text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); añadir(e.clipboardData.files); } }}
          placeholder={state.ended ? t('placeholderEnded') : state.hostConnected ? t('placeholderReady') : t('hostOffline')}
          disabled={disabled}
        />
        <div className="chat-input__bar">
          <div className="chat-input__tools">
            <input ref={fileRef} type="file" multiple accept={canImages ? ACCEPT : ACCEPT.replace('image/*,', '')} hidden onChange={(e) => { añadir(e.target.files); e.target.value = ''; }} />
            <button type="button" className="icon-btn" title={t('attach')} aria-label={t('attach')} disabled={disabled} onClick={() => fileRef.current?.click()}>
              <IconClip size={18} />
            </button>
            {canMention && (
              <button
                type="button"
                className="icon-btn remote__at"
                title={t('mentionFile')}
                aria-label={t('mentionFile')}
                onClick={() => { setInput((cur) => (cur && !/\s$/.test(cur) ? `${cur} @` : `${cur}@`)); textRef.current?.focus(); }}
              >
                @
              </button>
            )}
          </div>
          <div className="chat-input__meta">
            {state.meta?.model && <span className="remote__model">{state.meta.model}</span>}
          </div>
          {thinking ? (
            <button type="button" className="chat-input__send is-stop" title={t('stop')} aria-label={t('stop')} onClick={() => sendCommand({ type: 'interrupt' })}>
              <IconStop size={16} />
            </button>
          ) : (
            <button type="submit" className="chat-input__send" title={tc('send')} aria-label={tc('send')} disabled={disabled || sending || leyendo || (!input.trim() && !listos.length)}>
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

// ── Sesión en vivo ──────────────────────────────────────────────────────────

function RemoteSession({ session, t, tc }) {
  const locale = useLocale();
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [sendError, setSendError] = useState('');
  const [tab, setTab] = useState('chat');
  const seqRef = useRef(0);
  const threadRef = useRef(null);
  const stick = useRef(true);

  useEffect(() => { seqRef.current = state.lastSeq; }, [state.lastSeq]);

  // Auto-scroll al fondo con cada evento nuevo, salvo que el usuario haya
  // subido a leer.
  useEffect(() => {
    const el = threadRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.approvals]);
  const onScroll = () => {
    const el = threadRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Sesión ya terminada: sin canal en vivo, pero con transcript guardado. Se
  // lee de una vez y lo reproduce el mismo reducer que el streaming.
  const archived = session.status === 'ended';
  useEffect(() => {
    if (!archived) return undefined;
    let alive = true;
    api.get(`/api/remote/sessions/${session.id}/transcript`)
      .then((res) => {
        if (!alive) return;
        for (const ev of res.data.events || []) dispatch(ev);
      })
      .catch(() => {
        if (alive) dispatch({ type: 'error', message: t('transcriptError') });
      })
      .finally(() => { if (alive) dispatch({ type: 'session_ended' }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, archived]);

  useEffect(() => {
    if (archived) return undefined;
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
  }, [session.id, archived]);

  const sendCommand = useCallback(async (command, { quiet = false } = {}) => {
    try {
      await api.post(`/api/remote/sessions/${session.id}/commands`, command);
      if (!quiet) setSendError('');
      if (!quiet && command.type === 'prompt') stick.current = true;
      return true;
    } catch (err) {
      if (!quiet) setSendError(mensajeDeError(err, t('message')));
      return false;
    }
  }, [session.id, t]);

  const title = state.meta?.title || session.title || t('defaultSessionTitle');
  const canOrch = !archived && (state.meta?.capabilities || []).includes('orch');
  const orchBusy = !!state.orch?.tasks?.some((x) => !['done', 'failed', 'stopped', 'exited'].includes(x.status));
  const statusLabel = state.ended
    ? t('sessionEndedStatus')
    : !state.hostConnected
      ? t('hostOffline')
      : state.agentState === 'thinking'
        ? t('agentThinking')
        : t('connected');

  return (
    <main className="remote__session">
      <div className="remote__head">
        <div className="remote__head-text">
          <h1 className="remote__title">{title}</h1>
          <p className={`remote__dim ${state.ended ? 'remote__dim--danger' : ''}`}>
            {SOURCE_LABEL[state.meta?.source || session.source] || ''}
            {state.meta?.machine ? ` · ${state.meta.machine}` : ''}
            {' · '}{statusLabel}
          </p>
        </div>
        {canOrch && (
          <div className="rseg remote__tabs" role="tablist">
            {[['chat', t('tabChat')], ['orch', t('tabOrch')]].map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? 'is-on' : ''} onClick={() => setTab(v)}>
                {label}
                {v === 'orch' && orchBusy && <span className="remote__tab-dot" />}
              </button>
            ))}
          </div>
        )}
        <span className={`remote__dot remote__dot--lg ${state.hostConnected && !state.ended ? 'is-online' : ''}`} />
      </div>

      {canOrch && tab === 'orch' ? (
        <div className="remote__thread remote__thread--orch"><RemoteOrch state={state} sendCommand={sendCommand} /></div>
      ) : (
      <div className="remote__thread" ref={threadRef} onScroll={onScroll}>
        {groupItems(state.items).map((item) => {
          if (item.kind === 'tools') return <ToolLine key={item.key} items={item.items} t={t} locale={locale} />;
          if (item.kind === 'user') {
            return (
              <div key={item.key} className="msg msg--user">
                {(item.images > 0 || item.mentions?.length > 0) && (
                  <span className="remote__extras">
                    {item.mentions?.map((m) => <span key={m.path || m.name} className="remote__extra">@{m.name || m.rel}</span>)}
                    {item.images > 0 && <span className="remote__extra"><IconImage size={12} /> {item.images}</span>}
                  </span>
                )}
                {item.text}
              </div>
            );
          }
          if (item.kind === 'notice') return <div key={item.key} className="remote__notice"><Markdown>{item.text}</Markdown></div>;
          if (item.kind === 'error') {
            return <div key={item.key} className="remote__error">{item.text}</div>;
          }
          return (
            <div key={item.key} className="msg msg--assistant">
              {item.text
                ? <Markdown>{item.text}</Markdown>
                : item.open ? <span className="remote__dim">{t('thinkingDim')}</span> : null}
            </div>
          );
        })}
        {!state.items.length && (
          <p className="remote__dim remote__hint">
            {state.hostConnected ? t('hintConnected') : t('hintWaiting')}
          </p>
        )}
      </div>
      )}

      <div className="remote__dock">
        {state.approvals.map((a) => (
          <div key={a.id} className="remote__approval">
            <p>
              <strong>{a.risk === 'command' ? t('approvalCommand') : t('approvalChange')}</strong>
            </p>
            <code>{a.tool}{a.summary ? `  ${a.summary}` : ''}</code>
            <div className="remote__approval-actions">
              <button className="pill-btn pill-btn--outline" onClick={() => sendCommand({ type: 'approve', id: a.id, decision: 'deny' })}>
                {t('deny')}
              </button>
              <button className="pill-btn pill-btn--primary" onClick={() => sendCommand({ type: 'approve', id: a.id, decision: 'allow' })}>
                {t('allow')}
              </button>
            </div>
          </div>
        ))}
        {sendError && <p className="remote__send-error" role="alert">{sendError}</p>}
        {!archived && <RemoteComposer state={state} sendCommand={sendCommand} t={t} tc={tc} />}
      </div>
    </main>
  );
}
