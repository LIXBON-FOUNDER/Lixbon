// Settings.jsx — ajustes de la app: perfil/plan, API key, servidor,
// actualizaciones y editor. Las API keys se administran en la web.
import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useChatStore } from '../../store/chatStore';
import { useVersion } from '../../hooks/useVersion';
import { planColor } from '../../lib/planColors';
import { useTheme } from '../../lib/theme';
import { openExternal } from '../../lib/tauri';
import { IconEye, IconEyeOff, IconCopy, IconCheck } from '../../components/Icons';

function normalizeUrl(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function Settings() {
  const {
    serverUrl, setServerUrl,
    apiKey, user, setUser, logout,
    editorFontSize, setEditorFontSize,
    tabSize, setTabSize, insertSpaces, setInsertSpaces,
    autoSave, setAutoSave,
    visionModel, setVisionModel, availableModels,
  } = useAppStore();
  const autoVision = useAppStore((s) => s.effectiveVisionModel());
  const { agentMode, setAgentMode, autoApprove, setAutoApprove, nativeTools, setNativeTools } = useChatStore();
  const { currentVersion, checkForUpdates, updateInfo } = useVersion();
  const [theme, setThemeMode] = useTheme();

  const [urlInput, setUrlInput] = useState(serverUrl);
  const [urlStatus, setUrlStatus] = useState(null); // { ok, text }
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [keyStatus, setKeyStatus] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);

  const displayName =
    user?.first_name ? `${user.first_name} ${user.last_name || ''}`.trim()
    : user?.username || user?.email || '—';

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 12)}${'•'.repeat(16)}${apiKey.slice(-4)}`
    : '';

  const handleTestUrl = async () => {
    const url = normalizeUrl(urlInput);
    if (!url) return;
    setUrlStatus({ ok: null, text: 'Comprobando…' });
    const start = performance.now();
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        setServerUrl(url);
        setUrlInput(url);
        setUrlStatus({ ok: true, text: `Conectado y guardado (${Math.round(performance.now() - start)} ms)` });
      } else {
        setUrlStatus({ ok: false, text: `El servidor respondió ${res.status}.` });
      }
    } catch {
      setUrlStatus({ ok: false, text: 'No se pudo conectar con esa URL.' });
    }
  };

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  const handleRevalidate = async () => {
    setRevalidating(true);
    setKeyStatus('');
    try {
      const res = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        setUser((await res.json()).user);
        setKeyStatus('La key es válida. Perfil actualizado.');
      } else if (res.status === 401) {
        setKeyStatus('La key ya no es válida: fue revocada o expiró.');
      } else {
        setKeyStatus(`El servidor respondió ${res.status}.`);
      }
    } catch {
      setKeyStatus('No se pudo conectar con el servidor.');
    } finally {
      setRevalidating(false);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateChecked(false);
    try {
      await checkForUpdates();
    } finally {
      setCheckingUpdate(false);
      setUpdateChecked(true);
    }
  };

  return (
    <div className="settings">
      <h2 className="center-view__title">Ajustes</h2>

      {/* Perfil y plan */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">Cuenta</h3>
        <div className="settings__rows">
          <div className="settings__row">
            <span className="settings__row-label">Usuario</span>
            <span className="settings__row-value">{displayName}</span>
          </div>
          {user?.email && (
            <div className="settings__row">
              <span className="settings__row-label">Correo</span>
              <span className="settings__row-value">{user.email}</span>
            </div>
          )}
          <div className="settings__row">
            <span className="settings__row-label">Plan</span>
            <span className="settings__row-value" style={{ color: planColor(user?.plan_id) }}>
              {user?.plan_name || 'Gratuito'}
            </span>
          </div>
        </div>
        <div className="settings__actions">
          <button
            className="pill-btn pill-btn--outline"
            onClick={() => openExternal(`${serverUrl}/account`)}
          >
            Gestionar cuenta en la web
          </button>
          <button className="pill-btn pill-btn--outline settings__danger" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
      </section>

      {/* API key */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">API key</h3>
        <div className="settings__key">
          <code className="settings__key-value">{showKey ? apiKey : maskedKey}</code>
          <span className="settings__key-actions">
            <button className="icon-btn" onClick={() => setShowKey(!showKey)} title={showKey ? 'Ocultar' : 'Mostrar'}>
              {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button className="icon-btn" onClick={handleCopyKey} title="Copiar">
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </button>
          </span>
        </div>
        <div className="settings__actions">
          <button className="pill-btn pill-btn--outline" onClick={handleRevalidate} disabled={revalidating}>
            {revalidating ? 'Comprobando…' : 'Revalidar key'}
          </button>
          <button
            className="pill-btn pill-btn--outline"
            onClick={() => openExternal(`${serverUrl}/account`)}
          >
            Gestionar keys en la web
          </button>
        </div>
        {keyStatus && <p className="settings__status">{keyStatus}</p>}
      </section>

      {/* Servidor */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">Servidor</h3>
        <p className="settings__hint">
          URL del gateway de lixbon. Solo cámbiala si usas un túnel o despliegue propio.
        </p>
        <div className="settings__inline">
          <input
            className="settings__input"
            type="text"
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setUrlStatus(null); }}
            spellCheck={false}
          />
          <button className="pill-btn pill-btn--outline" onClick={handleTestUrl}>
            Probar y guardar
          </button>
        </div>
        {urlStatus && (
          <p className={`settings__status ${urlStatus.ok === false ? 'is-error' : ''}`}>
            {urlStatus.text}
          </p>
        )}
      </section>

      {/* Actualizaciones */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">Actualizaciones</h3>
        <div className="settings__rows">
          <div className="settings__row">
            <span className="settings__row-label">Versión instalada</span>
            <span className="settings__row-value">v{currentVersion || '…'}</span>
          </div>
        </div>
        <div className="settings__actions">
          <button className="pill-btn pill-btn--outline" onClick={handleCheckUpdate} disabled={checkingUpdate}>
            {checkingUpdate ? 'Buscando…' : 'Buscar actualizaciones'}
          </button>
        </div>
        {updateChecked && (
          <p className="settings__status">
            {updateInfo
              ? `Hay una versión nueva (${updateInfo.latest_version || 'disponible'}): usa el aviso superior para instalarla.`
              : 'Estás en la última versión.'}
          </p>
        )}
      </section>

      {/* Apariencia */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">Apariencia</h3>
        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Tema de la aplicación</span>
          <span className="settings__segmented">
            {[['light', 'Claro'], ['dark', 'Oscuro']].map(([mode, label]) => (
              <button
                key={mode}
                className={`settings__segment ${theme === mode ? 'is-active' : ''}`}
                onClick={() => setThemeMode(mode)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <p className="settings__hint">
          Un tema de VSCode activo (panel de extensiones) tiene prioridad sobre
          este modo mientras esté aplicado.
        </p>
      </section>

      {/* Editor */}
      <section className="settings__panel">
        <h3 className="settings__panel-title">Editor</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Autoguardado</span>
          <button
            className={`settings__toggle ${autoSave ? 'is-on' : ''}`}
            onClick={() => setAutoSave(!autoSave)}
            role="switch"
            aria-checked={autoSave}
            title={autoSave ? 'Se guarda 1 s después de dejar de escribir' : 'Guardado manual (Ctrl+S)'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Tamaño de letra</span>
          <span className="settings__slider">
            <input
              type="range"
              min="12"
              max="20"
              value={editorFontSize}
              onChange={(e) => setEditorFontSize(parseInt(e.target.value, 10))}
            />
            <span className="settings__slider-value">{editorFontSize}px</span>
          </span>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Tamaño del tabulador</span>
          <span className="settings__segmented">
            {[2, 4, 8].map((n) => (
              <button
                key={n}
                className={`settings__segment ${tabSize === n ? 'is-active' : ''}`}
                onClick={() => setTabSize(n)}
              >
                {n}
              </button>
            ))}
          </span>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Insertar espacios al tabular</span>
          <button
            className={`settings__toggle ${insertSpaces ? 'is-on' : ''}`}
            onClick={() => setInsertSpaces(!insertSpaces)}
            role="switch"
            aria-checked={insertSpaces}
            title={insertSpaces ? 'Se insertan espacios' : 'Se insertan tabulaciones'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Agente del chat</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Modo agente</span>
          <button
            className={`settings__toggle ${agentMode ? 'is-on' : ''}`}
            onClick={() => setAgentMode(!agentMode)}
            role="switch"
            aria-checked={agentMode}
            title={agentMode
              ? 'El modelo puede crear, editar y eliminar archivos del workspace'
              : 'El chat solo conversa, sin tocar archivos'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Aplicar cambios sin preguntar</span>
          <button
            className={`settings__toggle ${autoApprove ? 'is-on' : ''}`}
            onClick={() => setAutoApprove(!autoApprove)}
            role="switch"
            aria-checked={autoApprove}
            title={autoApprove
              ? 'El agente escribe directo en los archivos (el diff queda en el chat)'
              : 'Cada cambio pide aprobación con vista previa del diff'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Modelo de visión
            <span className="settings__row-hint">
              {' · '}describe las imágenes que adjuntas para el modelo de texto
              {autoVision ? '' : ' · instala uno en Ollama (p. ej. llava)'}
            </span>
          </span>
          <select
            className="settings__select"
            value={visionModel}
            onChange={(e) => setVisionModel(e.target.value)}
          >
            <option value="">{autoVision ? `Automático (${autoVision})` : 'Automático (ninguno)'}</option>
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Herramientas nativas
            <span className="settings__row-hint"> · requiere un modelo con soporte de tools (qwen2.5-coder, llama3.1…)</span>
          </span>
          <button
            className={`settings__toggle ${nativeTools ? 'is-on' : ''}`}
            onClick={() => setNativeTools(!nativeTools)}
            role="switch"
            aria-checked={nativeTools}
            title={nativeTools
              ? 'El modelo emite tool_calls nativos (más fiable). Si tu modelo no los soporta, desactívalo.'
              : 'Protocolo de texto (JSON embebido), compatible con cualquier modelo'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>
      </section>
    </div>
  );
}
