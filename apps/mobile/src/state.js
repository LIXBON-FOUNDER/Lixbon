// state.js — estado global con React Context:
//   PrefsContext → tema, personalización y servidor (AsyncStorage; nunca credenciales)
//   AuthContext  → sesión de este móvil (access de 30 min + refresh rotatorio
//                  en el Keystore vía expo-secure-store)
//   ChatContext  → modelos, conversación activa y streaming
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState as AppLifecycle } from 'react-native';

import { ApiClient, ApiException } from './api';
import { oauthAuthorize } from './oauth';
import { registerPushToken } from './push';
import { nivelesDe, thinkDe } from './razonamiento';
import { streamChatCompletion } from './sse';

// EXPO_PUBLIC_API_BASE: builds contra staging o el gateway simulado de las pruebas.
export const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://lixbon.com';
const SECURE_KEY = 'lixbon_api_key';
const REFRESH_KEY = 'lixbon_refresh_token';
const EXPIRES_KEY = 'lixbon_token_expires';
const SESSION_KEYS = [SECURE_KEY, REFRESH_KEY, EXPIRES_KEY];
const MOBILE_KEY_NAME = 'Lixbon Mobile';
// Se renueva un poco antes de caducar: un stream que se abre con un access a
// punto de expirar no debe recibir 401 a medias.
const RENEW_MARGIN_MS = 2 * 60 * 1000;

/// Lo que pide la app al entrar: una sesión de este móvil. issue_api_key y
/// key_name solo los entiende un gateway anterior, que responde con api_key.
const appLogin = () => ({
  client: 'mobile',
  device_name: Constants.deviceName || null,
  issue_api_key: true,
  key_name: MOBILE_KEY_NAME,
});
const UI_KEY = 'uiPrefs';
const DEFAULT_MODEL_KEY = 'defaultModel';
const RAZONAR_KEY = 'razonar';

export const UI_DEFAULTS = {
  accent: 'lima',
  textSize: 'md', // sm | md | lg — texto del chat
  density: 'normal', // compact | normal | roomy — aire entre mensajes y filas
  sendOnEnter: false,
  statusBar: false,
  ambient: false,
  motion: true,
  labs: false, // prototipo de supervisión con datos de ejemplo (Ajustes › Desarrolladores)
};

const UI_OPTIONS = {
  textSize: ['sm', 'md', 'lg'],
  density: ['compact', 'normal', 'roomy'],
};

function cleanUi(raw) {
  const out = { ...UI_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.accent === 'string') out.accent = raw.accent;
  for (const [k, vals] of Object.entries(UI_OPTIONS)) if (vals.includes(raw[k])) out[k] = raw[k];
  for (const k of ['sendOnEnter', 'statusBar', 'ambient', 'motion', 'labs']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

const ApiContext = createContext(null);
const PrefsContext = createContext(null);
const AuthContext = createContext(null);
const ChatContext = createContext(null);

export const useApi = () => useContext(ApiContext);
export const usePrefs = () => useContext(PrefsContext);
export const useAuth = () => useContext(AuthContext);
export const useChat = () => useContext(ChatContext);

export function AppState({ children }) {
  // Valores vivos que el ApiClient lee en cada petición (evita closures viejas).
  const live = useRef({
    apiBase: DEFAULT_API_BASE,
    apiKey: null,
    refresh: null,
    expiresAt: 0,
    renewing: null,
    renew: async () => null,
    onUnauthorized: () => {},
  }).current;
  const api = useMemo(
    () =>
      new ApiClient({
        getBase: () => live.apiBase,
        getToken: () => live.apiKey,
        renew: (rejected) => live.renew(rejected),
        onUnauthorized: () => live.onUnauthorized(),
      }),
    [live],
  );

  // ── Preferencias locales ─────────────────────────────────────────────────
  const [themeMode, setThemeModeState] = useState('dark'); // system | light | dark
  const [ui, setUiState] = useState(UI_DEFAULTS);
  const [apiBase, setApiBaseState] = useState(DEFAULT_API_BASE);
  const [prefsReady, setPrefsReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [mode, base, rawUi] = await Promise.all([
          AsyncStorage.getItem('themeMode'),
          AsyncStorage.getItem('apiBase'),
          AsyncStorage.getItem(UI_KEY),
        ]);
        if (mode === 'light' || mode === 'dark' || mode === 'system') setThemeModeState(mode);
        if (rawUi) setUiState(cleanUi(JSON.parse(rawUi)));
        if (base) {
          live.apiBase = base;
          setApiBaseState(base);
        }
      } catch {
        // sin preferencias guardadas
      }
      setPrefsReady(true);
    })();
  }, [live]);

  const setThemeMode = useCallback((mode) => {
    setThemeModeState(mode);
    AsyncStorage.setItem('themeMode', mode).catch(() => {});
  }, []);

  const setUi = useCallback((patch) => {
    setUiState((cur) => {
      const next = cleanUi({ ...cur, ...patch });
      AsyncStorage.setItem(UI_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // Restablecer la apariencia no apaga el prototipo de Desarrolladores.
  const resetUi = useCallback(() => {
    setUiState((cur) => {
      const next = { ...UI_DEFAULTS, labs: cur.labs };
      AsyncStorage.multiSet([[UI_KEY, JSON.stringify(next)], ['themeMode', 'dark']]).catch(() => {});
      return next;
    });
    setThemeModeState('dark');
  }, []);

  const setApiBase = useCallback(
    (value) => {
      const cleaned = value.trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
      live.apiBase = cleaned;
      setApiBaseState(cleaned);
      AsyncStorage.setItem('apiBase', cleaned).catch(() => {});
    },
    [live],
  );

  const prefs = useMemo(
    () => ({ themeMode, apiBase, ui, ready: prefsReady, setThemeMode, setApiBase, setUi, resetUi }),
    [themeMode, apiBase, ui, prefsReady, setThemeMode, setApiBase, setUi, resetUi],
  );

  // ── Sesión ───────────────────────────────────────────────────────────────
  const [authReady, setAuthReady] = useState(false);
  const [apiKey, setApiKey] = useState(null);
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(''); // aviso post-logout ("tu sesión expiró…")

  const adoptKey = useCallback(
    (key) => {
      live.apiKey = key;
      setApiKey(key);
    },
    [live],
  );

  /// Guarda la sesión de este móvil tal como la entrega el login o una renovación.
  const saveSession = useCallback(
    async (data) => {
      const expiresAt = Date.now() + data.expires_in * 1000;
      await Promise.all([
        SecureStore.setItemAsync(SECURE_KEY, data.access_token),
        SecureStore.setItemAsync(REFRESH_KEY, data.refresh_token),
        SecureStore.setItemAsync(EXPIRES_KEY, String(expiresAt)),
      ]);
      live.refresh = data.refresh_token;
      live.expiresAt = expiresAt;
      adoptKey(data.access_token);
    },
    [live, adoptKey],
  );

  // Una sola renovación en vuelo: dos con el mismo refresh harían que el
  // servidor cerrara la sesión. Con `rejected` (el access que recibió un 401)
  // se fuerza, salvo que otra petición ya lo haya renovado.
  live.renew = async (rejected = null) => {
    if (!live.refresh) return null;
    const vigente = rejected ? rejected !== live.apiKey : live.expiresAt - Date.now() > RENEW_MARGIN_MS;
    if (vigente) return live.apiKey;
    if (!live.renewing) {
      live.renewing = api
        .post('/api/auth/refresh', { refresh_token: live.refresh }, { auth: false })
        .then(async (data) => {
          await saveSession(data);
          return data.access_token;
        })
        .catch((err) => {
          if (err instanceof ApiException && err.status === 401) {
            live.refresh = null;
            return null;
          }
          throw err;
        })
        .finally(() => {
          live.renewing = null;
        });
    }
    return live.renewing;
  };

  const refreshMe = useCallback(async () => {
    try {
      const data = await api.get('/api/auth/me');
      if (data?.user && typeof data.user === 'object') setUser(data.user);
    } catch {
      // el 401 ya deslogueó vía onUnauthorized; otros errores no tumban la sesión
    }
  }, [api]);

  const logout = useCallback(
    async (withNotice = '') => {
      if (live.refresh) {
        // También en el servidor; sin red, la sesión caduca sola.
        api.post('/api/auth/logout', { refresh_token: live.refresh }, { auth: false }).catch(() => {});
      }
      await Promise.all(SESSION_KEYS.map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
      live.apiKey = null;
      live.refresh = null;
      live.expiresAt = 0;
      setApiKey(null);
      setUser(null);
      setNotice(withNotice);
    },
    [api, live],
  );

  live.onUnauthorized = () => logout('Tu sesión expiró. Inicia sesión de nuevo.');

  useEffect(() => {
    (async () => {
      try {
        const [key, refresh, expires] = await Promise.all(SESSION_KEYS.map((k) => SecureStore.getItemAsync(k)));
        if (key) {
          live.refresh = refresh || null;
          live.expiresAt = Number(expires) || 0;
          adoptKey(key);
          await refreshMe(); // renueva si hace falta; un 401 sin remedio dispara el logout
        }
      } catch {
        // Keystore no disponible: se queda deslogueado
      }
      setAuthReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adoptLogin = useCallback(
    async (data) => {
      if (data?.refresh_token) {
        await saveSession(data);
      } else {
        // Un gateway anterior a las sesiones de dispositivo solo entrega una key.
        const key = data?.api_key;
        if (typeof key !== 'string' || !key) {
          throw new ApiException('El servidor no entregó credenciales para la app');
        }
        await SecureStore.setItemAsync(SECURE_KEY, key);
        await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
        live.refresh = null;
        adoptKey(key);
      }
      if (data.user && typeof data.user === 'object') setUser(data.user);
      setNotice('');
      refreshMe(); // trae plan y settings completos
    },
    [live, adoptKey, saveSession, refreshMe],
  );

  const login = useCallback(
    async (email, password) => {
      const data = await api.post(
        '/api/auth/login',
        { email, password, ...appLogin() },
        { auth: false },
      );
      await adoptLogin(data);
    },
    [api, adoptLogin],
  );

  const register = useCallback(
    async ({ firstName, lastName, email, password }) => {
      await api.post(
        '/api/auth/register',
        { first_name: firstName, last_name: lastName, email, password },
        { auth: false },
      );
      // El registro entrega cookie de sesión (web); la app necesita la suya,
      // así que encadena un login normal con las mismas credenciales.
      await login(email, password);
    },
    [api, login],
  );

  const loginWithProvider = useCallback(
    async (provider) => {
      const result = await oauthAuthorize(provider, api.base);
      const data = await api.post(
        '/api/auth/oauth/exchange',
        {
          code: result.code,
          code_verifier: result.verifier,
          ...appLogin(),
        },
        { auth: false },
      );
      await adoptLogin(data);
    },
    [api, adoptLogin],
  );

  const closeOtherSessions = useCallback(() => api.delete('/api/auth/sessions'), [api]);

  /// Lo leen los streams al (re)conectar: deben usar el access vigente.
  const currentToken = useCallback(() => live.apiKey, [live]);

  // Con la app abierta, y al volver del segundo plano, el access se mantiene
  // vigente aunque no haya peticiones: los streams lo leen al conectar.
  useEffect(() => {
    if (!apiKey) return undefined;
    const tick = () => live.renew().catch(() => null);
    const timer = setInterval(tick, 60000);
    const sub = AppLifecycle.addEventListener('change', (state) => state === 'active' && tick());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [apiKey, live]);

  const clearNotice = useCallback(() => setNotice(''), []);

  // Con sesión activa, registra el push token del dispositivo (avisos de
  // /remote con la app cerrada). Best-effort: sin FCM/permiso es un no-op.
  useEffect(() => {
    if (apiKey) registerPushToken(api);
  }, [apiKey, api]);

  const auth = useMemo(
    () => ({
      ready: authReady,
      apiKey,
      user,
      notice,
      login,
      register,
      loginWithProvider,
      closeOtherSessions,
      currentToken,
      refreshMe,
      logout,
      clearNotice,
    }),
    [authReady, apiKey, user, notice, login, register, loginWithProvider, closeOtherSessions, currentToken, refreshMe, logout, clearNotice],
  );

  return (
    <ApiContext.Provider value={api}>
      <PrefsContext.Provider value={prefs}>
        <AuthContext.Provider value={auth}>
          <ChatState api={api} apiKey={apiKey} ready={prefsReady && authReady}>
            {children}
          </ChatState>
        </AuthContext.Provider>
      </PrefsContext.Provider>
    </ApiContext.Provider>
  );
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function ChatState({ api, apiKey, ready, children }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [defaultModel, setDefaultModelState] = useState('');
  const defaultModelRef = useRef('');
  const [conversationId, setConversationId] = useState(null);
  const [title, setTitle] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [usage, setUsage] = useState(null); // {used, total} del último turno
  const [modelInfo, setModelInfo] = useState({});
  const [razonar, setRazonarState] = useState('auto');
  const [quota, setQuota] = useState(null); // aviso de cupo de sesión/semana del gateway
  const draftRef = useRef(''); // texto del compositor (sobrevive al cambio de pestaña)

  const handleRef = useRef(null);
  const hadHistoryRef = useRef(false); // la conversación ya existía (no pedir auto-título)
  const messagesRef = useRef([]); // espejo síncrono para send()
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const loadModels = useCallback(async () => {
    try {
      const res = await api.get('/v1/models');
      const ids = (Array.isArray(res?.data) ? res.data : [])
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string' && !id.startsWith('error:'));
      setModelInfo(
        Object.fromEntries(
          (Array.isArray(res?.data) ? res.data : [])
            .filter((m) => typeof m?.id === 'string')
            .map((m) => [m.id, { reasoning: m.reasoning, real: m.model || m.id }]),
        ),
      );
      if (!defaultModelRef.current) {
        defaultModelRef.current = (await AsyncStorage.getItem(DEFAULT_MODEL_KEY).catch(() => null)) || '';
        setDefaultModelState(defaultModelRef.current);
      }
      const preferred = ids.includes(defaultModelRef.current) ? defaultModelRef.current : ids[0] || '';
      setModels(ids);
      setModel((current) => (current && ids.includes(current) ? current : preferred));
    } catch {
      setModels([]);
    }
  }, [api]);

  useEffect(() => {
    AsyncStorage.getItem(RAZONAR_KEY)
      .then((v) => v && setRazonarState(v))
      .catch(() => {});
  }, []);

  const setRazonar = useCallback((valor) => {
    setRazonarState(valor);
    AsyncStorage.setItem(RAZONAR_KEY, valor).catch(() => {});
  }, []);

  const setDefaultModel = useCallback((id) => {
    defaultModelRef.current = id;
    setDefaultModelState(id);
    setModel(id);
    AsyncStorage.setItem(DEFAULT_MODEL_KEY, id).catch(() => {});
  }, []);

  const stop = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setStreaming(false);
  }, []);

  const newChat = useCallback(() => {
    stop();
    setConversationId(null);
    setTitle(null);
    setMessages([]);
    setError('');
    setUsage(null);
    hadHistoryRef.current = false;
  }, [stop]);

  const openConversation = useCallback(
    async (id, withTitle = null) => {
      stop();
      setConversationId(id);
      setTitle(withTitle);
      setMessages([]);
      setError('');
      setUsage(null);
      setLoadingMessages(true);
      hadHistoryRef.current = true;
      try {
        const res = await api.get(`/api/conversations/${id}/messages`);
        const msgs = (Array.isArray(res?.messages) ? res.messages : [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({ role: m.role, content: m.content || '' }));
        setMessages(msgs);
        if (typeof res?.conversation?.title === 'string') setTitle(res.conversation.title);
      } catch (err) {
        setError(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
      } finally {
        setLoadingMessages(false);
      }
    },
    [api, stop],
  );

  const generateTitle = useCallback(
    async (convId) => {
      try {
        const res = await api.post(`/api/conversations/${convId}/generate-title`);
        if (typeof res?.title === 'string') {
          setConversationId((current) => {
            if (current === convId) setTitle(res.title);
            return current;
          });
        }
      } catch {
        // sin título automático: no es crítico
      }
    },
    [api],
  );

  // `thread` es lo que se ve y termina en el mensaje del usuario; es también
  // lo que viaja al modelo.
  const respond = useCallback(
    ({ thread, convId, isFirstExchange }) => {
      setConversationId(convId);
      setMessages([...thread, { role: 'assistant', content: '' }]);
      setStreaming(true);
      setError('');
      setQuota(null);

      handleRef.current = streamChatCompletion({
        base: api.base,
        token: apiKey,
        model,
        messages: thread.map((m) => ({ role: m.role, content: m.content })),
        conversationId: convId,
        webSearch,
        think: thinkDe(razonar, nivelesDe(modelInfo[model])),
        onQuota: setQuota,
        onDelta: (delta) => {
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1];
            return [...msgs.slice(0, -1), { ...last, content: last.content + delta }];
          });
        },
        onSources: (sources) => {
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1];
            return [...msgs.slice(0, -1), { ...last, sources }];
          });
        },
        onUsage: setUsage,
        onDone: () => {
          handleRef.current = null;
          setStreaming(false);
          if (isFirstExchange) generateTitle(convId);
        },
        onError: (err) => {
          handleRef.current = null;
          // Si no llegó nada, se retira la burbuja vacía del asistente
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1];
            return last && last.role === 'assistant' && !last.content ? msgs.slice(0, -1) : msgs;
          });
          setStreaming(false);
          if (err?.quota) {
            setQuota(err.quota);
            return;
          }
          setError(
            err instanceof ApiException ? err.message : 'Se perdió la conexión con el servidor',
          );
        },
      });
    },
    [api, apiKey, model, webSearch, razonar, modelInfo, generateTitle],
  );

  const send = useCallback(
    (text) => {
      const trimmed = text.trim();
      if (handleRef.current || !trimmed) return;
      if (!model) {
        setError('No hay modelos disponibles ahora mismo. Reintenta en un momento.');
        return;
      }
      const current = messagesRef.current;
      draftRef.current = '';
      respond({
        thread: [...current, { role: 'user', content: trimmed }],
        convId: conversationId || Crypto.randomUUID(),
        isFirstExchange: current.length === 0 && !hadHistoryRef.current,
      });
    },
    [model, conversationId, respond],
  );

  // Rehace la última respuesta. El gateway vuelve a guardar el mensaje del
  // usuario, así que antes se retira del historial el turno anterior.
  const regenerate = useCallback(async () => {
    if (handleRef.current || !model) return;
    const current = messagesRef.current;
    let lastUser = current.length - 1;
    while (lastUser >= 0 && current[lastUser].role !== 'user') lastUser -= 1;
    if (lastUser < 0) return;
    const convId = conversationId || Crypto.randomUUID();
    if (conversationId) {
      try {
        await api.post(`/api/conversations/${conversationId}/rewind`);
      } catch {
        // servidor sin rewind: se regenera igual
      }
    }
    respond({ thread: current.slice(0, lastUser + 1), convId, isFirstExchange: false });
  }, [api, model, conversationId, respond]);

  // Al cerrar sesión se descarta la conversación en curso.
  useEffect(() => {
    if (ready && !apiKey) newChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, ready]);

  const chat = useMemo(
    () => ({
      models,
      model,
      defaultModel,
      setDefaultModel,
      conversationId,
      title,
      messages,
      streaming,
      loadingMessages,
      error,
      webSearch,
      usage,
      razonar,
      setRazonar,
      nivelesRazonar: nivelesDe(modelInfo[model]),
      quota,
      clearQuota: () => setQuota(null),
      draftRef,
      loadModels,
      setModel,
      setTitle,
      setWebSearch,
      clearError: () => setError(''),
      newChat,
      openConversation,
      send,
      regenerate,
      stop,
    }),
    [models, model, defaultModel, setDefaultModel, conversationId, title, messages, streaming, loadingMessages, error, webSearch, usage, razonar, setRazonar, modelInfo, quota, loadModels, newChat, openConversation, send, regenerate, stop],
  );

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
