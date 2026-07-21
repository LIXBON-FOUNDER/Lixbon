// state.js — estado global con React Context:
//   PrefsContext → tema y servidor (AsyncStorage; nunca credenciales)
//   AuthContext  → sesión (API key "Lixbon Mobile" en el Keystore vía
//                  expo-secure-store) — se rota en cada login
//   ChatContext  → modelos, conversación activa y streaming
import AsyncStorage from '@react-native-async-storage/async-storage';
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

import { ApiClient, ApiException } from './api';
import { oauthAuthorize } from './oauth';
import { registerPushToken } from './push';
import { streamChatCompletion } from './sse';

export const DEFAULT_API_BASE = 'https://lixbon.com';
const SECURE_KEY = 'lixbon_api_key';
const MOBILE_KEY_NAME = 'Lixbon Mobile';

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
  const live = useRef({ apiBase: DEFAULT_API_BASE, apiKey: null, onUnauthorized: () => {} }).current;
  const api = useMemo(
    () =>
      new ApiClient({
        getBase: () => live.apiBase,
        getToken: () => live.apiKey,
        onUnauthorized: () => live.onUnauthorized(),
      }),
    [live],
  );

  // ── Preferencias locales ─────────────────────────────────────────────────
  const [themeMode, setThemeModeState] = useState('system'); // system | light | dark
  const [apiBase, setApiBaseState] = useState(DEFAULT_API_BASE);
  const [prefsReady, setPrefsReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [mode, base] = await Promise.all([
          AsyncStorage.getItem('themeMode'),
          AsyncStorage.getItem('apiBase'),
        ]);
        if (mode === 'light' || mode === 'dark') setThemeModeState(mode);
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
    () => ({ themeMode, apiBase, setThemeMode, setApiBase }),
    [themeMode, apiBase, setThemeMode, setApiBase],
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
      try {
        await SecureStore.deleteItemAsync(SECURE_KEY);
      } catch {
        // ya borrada
      }
      live.apiKey = null;
      setApiKey(null);
      setUser(null);
      setNotice(withNotice);
    },
    [live],
  );

  live.onUnauthorized = () => logout('Tu sesión expiró. Inicia sesión de nuevo.');

  useEffect(() => {
    (async () => {
      try {
        const key = await SecureStore.getItemAsync(SECURE_KEY);
        if (key) {
          adoptKey(key);
          await refreshMe(); // valida la key; un 401 dispara el logout
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
      const key = data?.api_key;
      if (typeof key !== 'string' || !key) {
        throw new ApiException('El servidor no entregó credenciales para la app');
      }
      await SecureStore.setItemAsync(SECURE_KEY, key);
      adoptKey(key);
      if (data.user && typeof data.user === 'object') setUser(data.user);
      setNotice('');
      refreshMe(); // trae plan y settings completos
    },
    [adoptKey, refreshMe],
  );

  const login = useCallback(
    async (email, password) => {
      const data = await api.post(
        '/api/auth/login',
        { email, password, issue_api_key: true, key_name: MOBILE_KEY_NAME },
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
      // El registro entrega cookie de sesión (web); la app necesita su API key,
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
          issue_api_key: true,
          key_name: MOBILE_KEY_NAME,
        },
        { auth: false },
      );
      await adoptLogin(data);
    },
    [api, adoptLogin],
  );

  /// La regeneración desde Cuenta devuelve una key nueva: se adopta al instante.
  const adoptApiKey = useCallback(
    async (rawKey) => {
      await SecureStore.setItemAsync(SECURE_KEY, rawKey);
      adoptKey(rawKey);
    },
    [adoptKey],
  );

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
      adoptApiKey,
      refreshMe,
      logout,
      clearNotice,
    }),
    [authReady, apiKey, user, notice, login, register, loginWithProvider, adoptApiKey, refreshMe, logout, clearNotice],
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
  const [conversationId, setConversationId] = useState(null);
  const [title, setTitle] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState('');
  const [webSearch, setWebSearch] = useState(false);
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
      setModels(ids);
      setModel((current) => (current && ids.includes(current) ? current : ids[0] || ''));
    } catch {
      setModels([]);
    }
  }, [api]);

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
    hadHistoryRef.current = false;
  }, [stop]);

  const openConversation = useCallback(
    async (id, withTitle = null) => {
      stop();
      setConversationId(id);
      setTitle(withTitle);
      setMessages([]);
      setError('');
      setLoadingMessages(true);
      hadHistoryRef.current = true;
      try {
        const res = await api.get(`/api/conversations/${id}/messages`);
        const msgs = (Array.isArray(res?.messages) ? res.messages : [])
          .filter((m) => m && typeof m.role === 'string')
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

  const send = useCallback(
    (text) => {
      const trimmed = text.trim();
      if (handleRef.current || !trimmed) return;
      if (!model) {
        setError('No hay modelos disponibles ahora mismo. Reintenta en un momento.');
        return;
      }

      const current = messagesRef.current;
      const convId = conversationId || Crypto.randomUUID();
      const isFirstExchange = current.length === 0 && !hadHistoryRef.current;
      const history = [
        ...current.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: trimmed },
      ];

      setConversationId(convId);
      setMessages([
        ...current,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);
      setError('');
      draftRef.current = '';

      handleRef.current = streamChatCompletion({
        base: api.base,
        token: apiKey,
        model,
        messages: history,
        conversationId: convId,
        webSearch,
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
          setError(
            err instanceof ApiException ? err.message : 'Se perdió la conexión con el servidor',
          );
        },
      });
    },
    [api, apiKey, model, conversationId, webSearch, generateTitle],
  );

  // Al cerrar sesión se descarta la conversación en curso.
  useEffect(() => {
    if (ready && !apiKey) newChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, ready]);

  const chat = useMemo(
    () => ({
      models,
      model,
      conversationId,
      title,
      messages,
      streaming,
      loadingMessages,
      error,
      webSearch,
      draftRef,
      loadModels,
      setModel,
      setWebSearch,
      clearError: () => setError(''),
      newChat,
      openConversation,
      send,
      stop,
    }),
    [models, model, conversationId, title, messages, streaming, loadingMessages, error, webSearch, loadModels, newChat, openConversation, send, stop],
  );

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
