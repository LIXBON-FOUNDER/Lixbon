// DownloadsPage.jsx — descargas públicas (/descargas): app de escritorio y CLI.
// El CLI se instala con un comando (PowerShell en Windows, bash en Linux/macOS)
// que baja e instala client_cli.py y crea el lanzador `folax`.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { CodeBlock } from '../components/CodeBlock';
import { IconDownload, IconTerminal, IconWindow } from '../components/Icons';

export default function DownloadsPage() {
  const [desktop, setDesktop] = useState(null);
  const [os, setOs] = useState('windows');

  // Origen del gateway (para los comandos de instalación del CLI)
  const base = useMemo(() => window.location.origin, []);

  useEffect(() => {
    api.get('/api/updates/latest/stable')
      .then((res) => setDesktop(res.data))
      .catch(() => setDesktop({ available: false }));
    if (/Mac|Linux|X11/.test(navigator.platform) && !/Win/.test(navigator.platform)) {
      setOs('unix');
    }
  }, []);

  const winCmd = `irm ${base}/install.ps1 | iex`;
  const unixCmd = `curl -fsSL ${base}/install.sh | bash`;

  return (
    <div className="page page--cream">
      <PublicNav />
      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">Descargas</h1>
        <p className="plans__sub">Lleva FOLAX a tu escritorio y a tu terminal.</p>

        <div className="downloads">
          {/* ── App de escritorio ── */}
          <section className="dl-card">
            <div className="dl-card__icon"><IconWindow size={26} /></div>
            <h2 className="dl-card__title">App de escritorio</h2>
            <p className="dl-card__desc">
              La experiencia completa de FOLAX en una app nativa para Windows, con
              actualizaciones automáticas.
            </p>
            {desktop?.available ? (
              <>
                <a href={desktop.download_url} className="pill-btn pill-btn--primary dl-card__cta">
                  <IconDownload size={16} /> Descargar v{desktop.version}
                </a>
                <span className="dl-card__meta">
                  {desktop.title} · {desktop.release_date}
                </span>
              </>
            ) : (
              <span className="pill-btn pill-btn--outline dl-card__cta is-soon">
                Próximamente
              </span>
            )}
          </section>

          {/* ── CLI ── */}
          <section className="dl-card dl-card--wide">
            <div className="dl-card__icon"><IconTerminal size={26} /></div>
            <h2 className="dl-card__title">Interfaz de línea de comandos (CLI)</h2>
            <p className="dl-card__desc">
              Chatea con el cluster desde tu terminal, con modo agente y contexto de
              tu carpeta de trabajo. Requiere Python 3.10 o superior.
            </p>

            <div className="os-tabs" role="tablist">
              <button
                role="tab" aria-selected={os === 'windows'}
                className={`os-tab ${os === 'windows' ? 'is-active' : ''}`}
                onClick={() => setOs('windows')}
              >
                Windows
              </button>
              <button
                role="tab" aria-selected={os === 'unix'}
                className={`os-tab ${os === 'unix' ? 'is-active' : ''}`}
                onClick={() => setOs('unix')}
              >
                Linux / macOS
              </button>
            </div>

            {os === 'windows' ? (
              <>
                <p className="dl-card__step">1. Abre <strong>PowerShell</strong> y ejecuta:</p>
                <CodeBlock code={winCmd} />
                <p className="dl-card__note">
                  Instala el CLI en <code>%USERPROFILE%\.folax</code> y agrega el comando{' '}
                  <code>folax</code> a tu PATH. Abre una terminal nueva después de instalar.
                </p>
              </>
            ) : (
              <>
                <p className="dl-card__step">1. Abre tu <strong>terminal</strong> y ejecuta:</p>
                <CodeBlock code={unixCmd} />
                <p className="dl-card__note">
                  Instala el CLI en <code>~/.folax</code> y crea el comando{' '}
                  <code>folax</code> en <code>~/.local/bin</code>.
                </p>
              </>
            )}

            <p className="dl-card__step">2. Configura y empieza a chatear:</p>
            <CodeBlock code={`folax setup`} />
            <CodeBlock code={`folax chat`} />

            <details className="dl-details">
              <summary>Instalación manual (sin script)</summary>
              <p className="dl-card__note">
                Descarga <a href={`${base}/install/client_cli.py`}>client_cli.py</a> y ejecútalo con Python:
              </p>
              <CodeBlock code={`python client_cli.py init --base-url ${base}/v1`} />
              <CodeBlock code={`python client_cli.py chat`} />
            </details>
          </section>
        </div>

        <p className="downloads__foot">
          ¿Buscas cómo usarlo? Lee la <a href="/docs">documentación</a>.
        </p>
      </main>
    </div>
  );
}
