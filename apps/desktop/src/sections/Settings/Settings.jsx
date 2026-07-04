import React, { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../lib/api';
import { 
  LuGlobe, 
  LuKey, 
  LuUser, 
  LuPaintbrush,
  LuEye,
  LuEyeOff,
  LuCopy,
  LuCheck
} from 'react-icons/lu';

export function Settings() {
  const {
    serverUrl, setServerUrl,
    theme, setTheme,
    accentColor, setAccentColor,
    terminalFontSize, setTerminalFontSize,
    terminalFontFamily, setTerminalFontFamily,
    apiKey, setApiKey,
    user, logout
  } = useAppStore();

  // Estados locales para formularios
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [isTestingUrl, setIsTestingUrl] = useState(false);
  const [urlSuccess, setUrlSuccess] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [latencyText, setLatencyText] = useState('');

  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRegeneratingKey, setIsRegeneratingKey] = useState(false);

  // Paleta de Colores Accent
  const colors = [
    { name: 'Violet', value: '#7c3aed' },
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Emerald', value: '#10b981' },
    { name: 'Rose', value: '#f43f5e' },
    { name: 'Amber', value: '#f59e0b' },
    { name: 'Cyan', value: '#06b6d4' }
  ];

  // Comprobar la URL
  const handleTestUrl = async () => {
    setIsTestingUrl(true);
    setUrlError('');
    setUrlSuccess(false);
    setLatencyText('');

    let url = urlInput.trim().replace(/\/+$/, '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    const start = performance.now();
    try {
      const response = await fetch(`${url}/health`, { method: 'GET' });
      if (response.ok) {
        const end = performance.now();
        setServerUrl(url);
        setUrlSuccess(true);
        setLatencyText(`${Math.round(end - start)}ms`);
      } else {
        setUrlError('El servidor respondió con código de error.');
      }
    } catch (err) {
      setUrlError('No se pudo conectar al servidor.');
    } finally {
      setIsTestingUrl(false);
    }
  };

  // Copiar API Key
  const handleCopyKey = () => {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Regenerar API Key
  const handleRegenerateKey = async () => {
    if (!window.confirm('¿Seguro que deseas regenerar tu clave API? Tu sesión actual se actualizará.')) return;
    setIsRegeneratingKey(true);
    try {
      const res = await api.post('/api/auth/api-key/regenerate');
      if (res && res.newApiKey) {
        setApiKey(res.newApiKey);
        alert('Nueva clave API generada y configurada.');
      }
    } catch (e) {
      alert('Error regenerando clave: ' + e.message);
    } finally {
      setIsRegeneratingKey(false);
    }
  };

  return (
    <div className="settings-page flex-col flex-1">
      <h2 className="section-title">Ajustes Generales</h2>

      <div className="settings-grid">
        {/* Panel 1: Conexión Tunnel */}
        <div className="settings-panel">
          <div className="panel-header flex align-center gap-2">
            <LuGlobe size={16} className="panel-icon" />
            <h3>CONEXIÓN CLOUDFLARE TUNNEL</h3>
          </div>
          <div className="panel-body flex flex-col gap-4">
            <div className="form-group flex flex-col gap-2">
              <label>Dirección del Servidor Remoto (URL del Túnel)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://folax-dtc.trycloudflare.com"
                  className="settings-input font-mono flex-1"
                />
                <button 
                  onClick={handleTestUrl} 
                  disabled={isTestingUrl}
                  className="settings-btn"
                >
                  {isTestingUrl ? 'Comprobando...' : 'Guardar'}
                </button>
              </div>
              {urlSuccess && <span className="success-text">Conexión establecida con éxito ({latencyText})</span>}
              {urlError && <span className="error-text">{urlError}</span>}
            </div>
          </div>
        </div>

        {/* Panel 2: API Key */}
        <div className="settings-panel">
          <div className="panel-header flex align-center gap-2">
            <LuKey size={16} className="panel-icon" />
            <h3>CLAVE DE ACCESO API KEY</h3>
          </div>
          <div className="panel-body flex flex-col gap-4">
            <div className="form-group flex flex-col gap-2">
              <label>Tu clave API de clúster actual</label>
              <div className="key-input-container flex align-center justify-between font-mono">
                <span className="key-text">
                  {showKey ? apiKey : 'flx_' + '•'.repeat(24) + (apiKey ? apiKey.slice(-4) : '????')}
                </span>
                
                <div className="flex gap-2">
                  <button onClick={() => setShowKey(!showKey)} className="icon-action-btn">
                    {showKey ? <LuEyeOff size={16} /> : <LuEye size={16} />}
                  </button>
                  <button onClick={handleCopyKey} className="icon-action-btn">
                    {copied ? <LuCheck size={16} style={{ color: 'var(--status-ok)' }} /> : <LuCopy size={16} />}
                  </button>
                </div>
              </div>
              
              <div className="flex justify-end">
                <button 
                  onClick={handleRegenerateKey} 
                  disabled={isRegeneratingKey}
                  className="settings-btn-danger"
                >
                  {isRegeneratingKey ? 'Regenerando...' : 'Regenerar API Key'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Panel 3: Perfil de Usuario */}
        {user && (
          <div className="settings-panel">
            <div className="panel-header flex align-center gap-2">
              <LuUser size={16} className="panel-icon" />
              <h3>PERFIL DE USUARIO</h3>
            </div>
            <div className="panel-body flex flex-col gap-2">
              <div className="profile-row flex justify-between font-mono">
                <span className="label">USUARIO:</span>
                <span className="value">{user.username}</span>
              </div>
              <div className="profile-row flex justify-between font-mono">
                <span className="label">PERMISOS MODELO:</span>
                <span className="value">{user.key_model || 'Acceso Libre'}</span>
              </div>
              <div className="flex justify-end" style={{ marginTop: '16px' }}>
                <button onClick={logout} className="settings-btn">
                  Cerrar Sesión (Disconnect)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Panel 4: Personalización / Apariencia */}
        <div className="settings-panel">
          <div className="panel-header flex align-center gap-2">
            <LuPaintbrush size={16} className="panel-icon" />
            <h3>INTERFAZ Y APARIENCIA</h3>
          </div>
          <div className="panel-body flex flex-col gap-4">
            {/* Tema Oscuro / Claro */}
            <div className="form-group flex justify-between align-center">
              <label>Modo de Interfaz (Tema Claro)</label>
              <button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className={`theme-toggle-switch ${theme === 'light' ? 'checked' : ''}`}
              >
                <span className="switch-dot"></span>
              </button>
            </div>

            {/* Accent Color Chips */}
            <div className="form-group flex flex-col gap-2">
              <label>Color Accent principal</label>
              <div className="color-chips flex gap-2">
                {colors.map((color) => {
                  const isSelected = accentColor === color.value;
                  return (
                    <button
                      key={color.name}
                      onClick={() => setAccentColor(color.value)}
                      className={`color-chip ${isSelected ? 'active' : ''}`}
                      style={{ backgroundColor: color.value }}
                      title={color.name}
                    >
                      {isSelected && <LuCheck size={14} style={{ color: '#fff' }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Font Size Slider */}
            <div className="form-group flex flex-col gap-2">
              <div className="flex justify-between">
                <label>Tamaño de Letra del Terminal</label>
                <span className="value-preview font-mono">{terminalFontSize}px</span>
              </div>
              <input
                type="range"
                min="12"
                max="20"
                value={terminalFontSize}
                onChange={(e) => setTerminalFontSize(parseInt(e.target.value, 10))}
                className="font-slider"
              />
            </div>

            {/* Font Family Dropdown */}
            <div className="form-group flex flex-col gap-2">
              <label>Tipografía del Terminal</label>
              <select
                value={terminalFontFamily}
                onChange={(e) => setTerminalFontFamily(e.target.value)}
                className="font-select font-mono"
              >
                <option value="JetBrains Mono">JetBrains Mono</option>
                <option value="Fira Code">Fira Code</option>
                <option value="Cascadia Code">Cascadia Code</option>
                <option value="Courier New">Courier New</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .settings-page {
          overflow-y: auto;
          height: 100%;
        }
        .settings-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 24px;
        }
        @media (min-width: 768px) {
          .settings-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
        .settings-panel {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 24px;
        }
        .panel-header {
          margin-bottom: 20px;
          border-bottom: 1px solid var(--border);
          padding-bottom: 12px;
        }
        .panel-header h3 {
          font-size: 0.9rem;
          font-weight: 700;
          color: #fff;
          letter-spacing: 0.05em;
        }
        .panel-icon {
          color: var(--accent);
        }
        .form-group label {
          font-size: 0.8rem;
          color: var(--text-secondary);
          font-weight: 500;
        }
        .settings-input {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 10px 14px;
          font-size: 0.9rem;
          color: #ffffff;
        }
        .light-theme .settings-input {
          color: var(--text-primary);
        }
        .settings-btn {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 10px 16px;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          color: #fff;
          transition: all 0.2s;
        }
        .light-theme .settings-btn {
          color: var(--text-primary);
        }
        .settings-btn:hover {
          border-color: var(--accent);
          color: #fff;
        }
        .settings-btn-danger {
          background-color: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 6px;
          padding: 10px 16px;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          color: var(--text-error);
          transition: all 0.2s;
        }
        .settings-btn-danger:hover {
          background-color: var(--text-error);
          color: #ffffff;
        }
        .key-input-container {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 10px 14px;
          font-size: 0.9rem;
          color: #ffffff;
        }
        .light-theme .key-input-container {
          color: var(--text-primary);
        }
        .icon-action-btn {
          color: var(--text-secondary);
          cursor: pointer;
        }
        .icon-action-btn:hover {
          color: #fff;
        }
        .profile-row {
          padding: 8px 0;
          border-bottom: 1px dashed var(--border);
          font-size: 0.8rem;
        }
        .profile-row .label {
          color: var(--text-secondary);
        }
        .profile-row .value {
          color: #fff;
          font-weight: 700;
        }
        .light-theme .profile-row .value {
          color: var(--text-primary);
        }
        .success-text {
          font-size: 0.75rem;
          color: var(--status-ok);
        }
        .error-text {
          font-size: 0.75rem;
          color: var(--status-error);
        }
        
        /* Toggle Switch */
        .theme-toggle-switch {
          width: 44px;
          height: 22px;
          border-radius: 11px;
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          position: relative;
          cursor: pointer;
          transition: background-color 0.2s;
        }
        .theme-toggle-switch.checked {
          background-color: var(--accent);
        }
        .switch-dot {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background-color: #fff;
          position: absolute;
          top: 2px;
          left: 2px;
          transition: transform 0.2s;
        }
        .theme-toggle-switch.checked .switch-dot {
          transform: translateX(22px);
        }

        /* Color Chips */
        .color-chip {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid transparent;
        }
        .color-chip.active {
          border-color: #ffffff;
          box-shadow: 0 0 8px var(--accent);
        }

        /* Sliders */
        .font-slider {
          -webkit-appearance: none;
          width: 100%;
          height: 4px;
          border-radius: 2px;
          background: var(--bg-surface);
          outline: none;
        }
        .font-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
        }

        /* Dropdowns */
        .font-select {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 8px 12px;
          color: #ffffff;
          cursor: pointer;
        }
        .light-theme .font-select {
          color: var(--text-primary);
        }
      `}} />
    </div>
  );
}
