// DownloadsPage.jsx — descargas públicas (/apps): app de escritorio,
// app de Android y CLI. Escritorio y Android van como dos cuadros iguales;
// el CLI se instala con un comando (PowerShell en Windows, bash en
// Linux/macOS) que baja e instala client_cli.py y crea el lanzador `lixbon`.
import { useSeo } from '../lib/seo';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { CodeBlock } from '../components/CodeBlock';
import { IconDownload, IconTerminal, IconCheck, IconPhone, IconChevron } from '../components/Icons';

const MAX_VERSIONES = 8;

// Las versiones del escritorio, de la más nueva a la más vieja, sin repetir.
// La primera estable es la recomendada; si aún no hay estable, la primera beta.
function versionesEscritorio(lista) {
  const vistas = new Set();
  return lista
    .filter((v) => (v.product || 'desktop') === 'desktop')
    .filter((v) => {
      const k = `${v.version}@${v.channel}`;
      if (vistas.has(k)) return false;
      vistas.add(k);
      return true;
    })
    .slice(0, MAX_VERSIONES);
}

export default function DownloadsPage() {
  const t = useT('downloads');
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/apps' });
  const [versiones, setVersiones] = useState(null);
  const [elegida, setElegida] = useState('');
  const [android, setAndroid] = useState(null);
  const [os, setOs] = useState('windows');

  // Origen del gateway (para los comandos de instalación del CLI)
  const base = useMemo(() => (typeof window === 'undefined' ? 'https://lixbon.com' : window.location.origin), []);

  useEffect(() => {
    api.get('/api/versions')
      .then((res) => {
        const lista = versionesEscritorio(Array.isArray(res.data) ? res.data : []);
        setVersiones(lista);
        const recomendada = lista.find((v) => v.channel === 'stable') || lista[0];
        if (recomendada) setElegida(`${recomendada.version}@${recomendada.channel}`);
      })
      .catch(() => setVersiones([]));
    api.get('/api/updates/latest/stable?product=android')
      .then((res) => setAndroid(res.data))
      .catch(() => setAndroid({ available: false }));
    if (/Mac|Linux|X11/.test(navigator.platform) && !/Win/.test(navigator.platform)) {
      setOs('unix');
    }
  }, []);

  const sel = versiones?.find((v) => `${v.version}@${v.channel}` === elegida);

  const winCmd = `irm ${base}/install.ps1 | iex`;
  const unixCmd = `curl -fsSL ${base}/install.sh | bash`;

  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">{t('title')}</h1>
        <p className="plans__sub">{t('subtitle')}</p>

        <div className="downloads">
          {/* ── Apps: escritorio + Android, dos cuadros iguales ── */}
          <div className="downloads__apps">
            <section className="dl-card dl-card--app">
              <div className="dl-card__head">
                <img src="/favicon.svg" alt="" className="dl-card__logo" draggable={false} />
                <div className="dl-card__heading">
                  <h2 className="dl-card__title">{t('desktopTitle')}</h2>
                  <p className="dl-card__desc">{t('desktopDesc')}</p>
                </div>
              </div>
              <ul className="dl-card__features">
                <li><IconCheck size={15} /> {t('desktopFeature1')}</li>
                <li><IconCheck size={15} /> {t('desktopFeature2')}</li>
                <li><IconCheck size={15} /> {t('desktopFeature3')}</li>
              </ul>
              <div className="dl-card__bottom">
                {versiones?.length ? (
                  <>
                    <div className="dl-picker">
                      <label className="dl-picker__select">
                        <select aria-label={t('version')} value={elegida} onChange={(e) => setElegida(e.target.value)}>
                          {versiones.map((v, i) => {
                            const recomendada = v.channel === 'stable' && versiones.findIndex((x) => x.channel === 'stable') === i;
                            return (
                              <option key={`${v.version}@${v.channel}`} value={`${v.version}@${v.channel}`}>
                                v{v.version} · {v.channel === 'stable' ? t('stable') : t('beta')}{recomendada ? ` · ${t('recommended')}` : ''}
                              </option>
                            );
                          })}
                        </select>
                        <IconChevron size={14} />
                      </label>
                      {sel && (
                        <a href={`/api/updates/download/${encodeURIComponent(sel.version)}/${sel.channel}`} className="pill-btn pill-btn--primary dl-card__cta">
                          <IconDownload size={16} /> {t('download')}
                        </a>
                      )}
                    </div>
                    {sel && (
                      <span className="dl-card__meta">
                        {sel.release_date} · Windows 10/11 (64 bits)
                        {sel.channel !== 'stable' && ` · ${t('betaNote')}`}
                      </span>
                    )}
                  </>
                ) : versiones === null ? (
                  <span className="dl-card__meta">{t('loading')}</span>
                ) : (
                  <span className="pill-btn pill-btn--outline dl-card__cta is-soon">
                    {t('comingSoon')}
                  </span>
                )}
              </div>
            </section>

            <section className="dl-card dl-card--android">
              <div className="dl-card__head">
                <div className="dl-card__icon"><IconPhone size={19} /></div>
                <div className="dl-card__heading">
                  <h2 className="dl-card__title">{t('androidTitle')}</h2>
                  <p className="dl-card__desc">{t('androidDesc')}</p>
                </div>
              </div>
              <ul className="dl-card__features">
                <li><IconCheck size={15} /> {t('androidFeature1')}</li>
                <li><IconCheck size={15} /> {t('androidFeature2')}</li>
                <li><IconCheck size={15} /> {t('androidFeature3')}</li>
              </ul>
              <div className="dl-card__bottom">
                {android?.available ? (
                  <>
                    <a href={android.download_url} className="pill-btn pill-btn--primary dl-card__cta">
                      <IconDownload size={16} /> {t('download')} v{android.version}
                    </a>
                    <span className="dl-card__meta">
                      {android.title} · {android.release_date} · APK · Android 7.0+
                    </span>
                  </>
                ) : (
                  <span className="pill-btn pill-btn--outline dl-card__cta is-soon">
                    {t('comingSoon')}
                  </span>
                )}
              </div>
            </section>
          </div>

          {/* ── CLI ── */}
          <section className="dl-card dl-card--cli">
            <div className="dl-card__head">
              <div className="dl-card__icon"><IconTerminal size={19} /></div>
              <div className="dl-card__heading">
                <h2 className="dl-card__title">{t('cliTitle')}</h2>
                <p className="dl-card__desc">{t('cliDesc')}</p>
              </div>
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
            </div>

            {os === 'windows' ? (
              <>
                <p className="dl-card__step">{t('step1Win')} <strong>PowerShell</strong> {t('step1WinRest')}</p>
                <CodeBlock code={winCmd} label="powershell" />
                <p className="dl-card__note">
                  {t('noteWin', { path: '%USERPROFILE%\\.lixbon', cmd: 'lixbon' })}
                </p>
              </>
            ) : (
              <>
                <p className="dl-card__step">{t('step1Unix')} <strong>terminal</strong> {t('step1UnixRest')}</p>
                <CodeBlock code={unixCmd} label="bash" />
                <p className="dl-card__note">
                  {t('noteUnix', { home: '~/.lixbon', cmd: 'lixbon', bin: '~/.local/bin' })}
                </p>
              </>
            )}

            <p className="dl-card__step">{t('step2')}</p>
            <CodeBlock code={`lixbon`} />

            <details className="dl-details">
              <summary>{t('manualInstall')}</summary>
              <p className="dl-card__note">
                {t('manualNote')} <a href={`${base}/install/client_cli.py`}>client_cli.py</a> {t('manualNoteRest')}
              </p>
              <CodeBlock code={`python client_cli.py init --base-url ${base}/v1`} />
              <CodeBlock code={`python client_cli.py chat`} />
            </details>
          </section>
        </div>

        <p className="downloads__foot">
          {t('footPrompt')} <Link to="/docs">{t('footLink')}</Link>.
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
