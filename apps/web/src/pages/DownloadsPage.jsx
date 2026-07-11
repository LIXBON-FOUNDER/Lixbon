// DownloadsPage.jsx — descargas públicas (/descargas): app de escritorio y CLI.
// El CLI se instala con un comando (PowerShell en Windows, bash en Linux/macOS)
// que baja e instala client_cli.py y crea el lanzador `lixbon`.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { CodeBlock } from '../components/CodeBlock';
import { IconDownload, IconTerminal, IconCheck } from '../components/Icons';

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
        <h1 className="page__title page__title--center">Aplicaciones</h1>
        <p className="plans__sub">Lleva lixbon a tu escritorio y a tu terminal.</p>

        <div className="downloads">
          {/* ── App de escritorio ── */}
          <section className="dl-card dl-card--app">
            <img src="/favicon.svg" alt="Icono de lixbon" className="dl-card__logo" draggable={false} />
            <h2 className="dl-card__title">App de escritorio</h2>
            <p className="dl-card__desc">
              La experiencia completa de lixbon en una app nativa para Windows.
            </p>
            <ul className="dl-card__features">
              <li><IconCheck size={15} /> Editor de código con chat integrado</li>
              <li><IconCheck size={15} /> Terminales, Git y explorador de archivos</li>
              <li><IconCheck size={15} /> Actualizaciones automáticas</li>
            </ul>
            <div className="dl-card__bottom">
              {desktop?.available ? (
                <>
                  <a href={desktop.download_url} className="pill-btn pill-btn--primary dl-card__cta">
                    <IconDownload size={16} /> Descargar v{desktop.version}
                  </a>
                  <span className="dl-card__meta">
                    {desktop.title} · {desktop.release_date} · Windows 10/11 (64 bits)
                  </span>
                </>
              ) : (
                <span className="pill-btn pill-btn--outline dl-card__cta is-soon">
                  Próximamente
                </span>
              )}
            </div>
          </section>

          {/* ── CLI ── */}
          <section className="dl-card dl-card--cli">
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
                  Instala el CLI en <code>%USERPROFILE%\.lixbon</code> y agrega el comando{' '}
                  <code>lixbon</code> a tu PATH. Abre una terminal nueva después de instalar.
                </p>
              </>
            ) : (
              <>
                <p className="dl-card__step">1. Abre tu <strong>terminal</strong> y ejecuta:</p>
                <CodeBlock code={unixCmd} />
                <p className="dl-card__note">
                  Instala el CLI en <code>~/.lixbon</code> y crea el comando{' '}
                  <code>lixbon</code> en <code>~/.local/bin</code>.
                </p>
              </>
            )}

            <p className="dl-card__step">
              2. Ejecuta el CLI; la primera vez te pedirá iniciar sesión (correo o API key):
            </p>
            <CodeBlock code={`lixbon`} />

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
