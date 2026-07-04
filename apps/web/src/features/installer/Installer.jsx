import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { LuLaptop, LuCopy, LuDownload, LuTerminal, LuFileCode } from 'react-icons/lu';
import '../../style/Installer.css';

export default function Installer() {
  const [serverBaseUrl, setServerBaseUrl] = useState('');

  useEffect(() => {
    // Intentamos obtener el server_base_url del backend, o usamos el origen actual
    api.get('/api/dashboard/init')
      .then(res => {
        setServerBaseUrl(res.data.server_base_url);
      })
      .catch(() => {
        // Fallback: usar el origin del navegador sin /v1
        setServerBaseUrl(window.location.origin);
      });
  }, []);

  const handleCopy = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-999999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      alert('Copiado al portapapeles');
    } catch (err) {
      console.error(err);
    }
  };

  const base = serverBaseUrl || window.location.origin;
  const linuxCmd = `curl -fsSL ${base}/install.sh | bash`;
  const winCmd = `irm ${base}/install.ps1 | iex`;

  return (
    <div id="installer" className="section-content active">
      <section className="panel">
        <h2><LuLaptop className="installer-icon" /> Cliente CLI remoto</h2>
        <p className="muted">
          Instala la interfaz de terminal en otros equipos de la red para que chateen usando este servidor.
        </p>

        <div className="grid-2 installer-grid">
          <div>
            <h3>Linux / macOS (bash)</h3>
            <div className="code-container">
              <pre><code id="cmd-linux-install">{linuxCmd}</code></pre>
              <button 
                className="copy-btn copy-btn-absolute"
                onClick={() => handleCopy(linuxCmd)}
              >
                <LuCopy className="copy-icon-size" />
              </button>
            </div>
          </div>
          <div>
            <h3>Windows (PowerShell)</h3>
            <div className="code-container">
              <pre><code id="cmd-win-install">{winCmd}</code></pre>
              <button 
                className="copy-btn copy-btn-absolute"
                onClick={() => handleCopy(winCmd)}
              >
                <LuCopy className="copy-icon-size" />
              </button>
            </div>
          </div>
        </div>

        <div className="download-box">
          <div>
            <h3 className="download-title">
              <LuDownload className="title-icon-size" /> 
              Descarga directa del script
            </h3>
            <p className="small muted download-desc">
              Si prefieres no usar el instalador automático, puedes descargar el script Python directamente aquí.
            </p>
          </div>
          <a 
            href={`${base}/install/client_cli.py`} 
            download
            className="download-btn"
          >
            <LuFileCode className="btn-icon-size" /> Descargar client_cli.py
          </a>
        </div>

        <div className="usage-box">
          <h3 className="usage-title">
            <LuTerminal className="title-icon-size" /> 
            Uso después de instalar
          </h3>
          <p className="small muted usage-desc">Abre una nueva terminal en el otro PC y ejecuta:</p>
          <code className="usage-code">folax setup</code>
          <code className="usage-code-last">folax chat</code>
        </div>
      </section>
    </div>
  );
}
