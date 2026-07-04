import React, { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { LuGlobe, LuArrowRight, LuSparkles } from 'react-icons/lu';

export function Onboarding() {
  const { setServerUrl, setConnectionStatus } = useAppStore();
  const [urlInput, setUrlInput] = useState('');
  const [error, setError] = useState('');
  const [isTesting, setIsTesting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!urlInput.trim()) {
      setError('Por favor, ingresa una URL válida');
      return;
    }

    setIsTesting(true);
    setError('');

    // Limpiar y normalizar URL
    let url = urlInput.trim().replace(/\/+$/, '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    try {
      const response = await fetch(`${url}/health`, { method: 'GET', timeout: 5000 });
      if (response.ok) {
        setServerUrl(url);
        setConnectionStatus('connected');
      } else {
        setError('El servidor respondió pero con código de error');
      }
    } catch (err) {
      setError('No se pudo conectar al servidor. Verifica la URL e inténtalo de nuevo.');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="onboarding-overlay flex align-center justify-center">
      <div className="onboarding-card flex flex-col gap-4">
        <div className="onboarding-header text-center">
          <div className="logo-glow">
            <LuSparkles size={40} className="glow-icon" />
          </div>
          <h1>Bienvenido a FOLAX DTC</h1>
          <p>Conéctate a tu gateway distribuido de LLM para comenzar</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="input-group">
            <label htmlFor="tunnel-url" className="flex align-center gap-2">
              <LuGlobe size={14} />
              <span>URL del Tunnel de Cloudflare</span>
            </label>
            <input
              id="tunnel-url"
              type="text"
              placeholder="https://folax-dtc.trycloudflare.com"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="url-input"
              disabled={isTesting}
            />
            {error && <span className="error-text">{error}</span>}
          </div>

          <button
            type="submit"
            className="btn-submit flex align-center justify-center gap-2"
            disabled={isTesting}
          >
            <span>{isTesting ? 'Comprobando conexión...' : 'Conectar Servidor'}</span>
            {!isTesting && <LuArrowRight size={16} />}
          </button>
        </form>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .onboarding-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background-color: rgba(5, 5, 5, 0.95);
          z-index: 9999;
          backdrop-filter: blur(10px);
        }
        .onboarding-card {
          max-width: 480px;
          width: 90%;
          background: linear-gradient(135deg, #111111 0%, #1a1a1a 100%);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 40px;
          box-shadow: 0 10px 40px rgba(124, 58, 237, 0.15), 0 0 1px 1px rgba(124, 58, 237, 0.1) inset;
        }
        .logo-glow {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: rgba(124, 58, 237, 0.1);
          border: 1px solid rgba(124, 58, 237, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 20px;
          box-shadow: 0 0 20px rgba(124, 58, 237, 0.2);
        }
        .glow-icon {
          color: var(--accent);
          filter: drop-shadow(0 0 8px var(--accent));
        }
        h1 {
          font-size: 1.8rem;
          font-weight: 700;
          color: #ffffff;
          margin-bottom: 8px;
        }
        p {
          font-size: 0.9rem;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .input-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 10px;
        }
        .input-group label {
          font-size: 0.8rem;
          color: var(--text-secondary);
          font-weight: 500;
        }
        .url-input {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 14px 16px;
          font-size: 0.95rem;
          color: #ffffff;
          width: 100%;
          transition: border-color 0.2s;
          font-family: var(--font-mono);
        }
        .url-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.2);
        }
        .error-text {
          font-size: 0.75rem;
          color: var(--text-error);
          margin-top: 4px;
        }
        .btn-submit {
          background-color: var(--accent);
          color: #ffffff;
          font-weight: 600;
          font-size: 0.95rem;
          padding: 14px;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 4px 14px rgba(var(--accent-rgb), 0.4);
          margin-top: 10px;
        }
        .btn-submit:hover {
          opacity: 0.95;
          transform: translateY(-1px);
        }
        .btn-submit:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
      `}} />
    </div>
  );
}
