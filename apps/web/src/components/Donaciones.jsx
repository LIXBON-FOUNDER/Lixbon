import { useState } from 'react';
import { Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { urlFounder } from '../lib/founder';
import { MONTOS, urlPaypal } from '../lib/donaciones';
import { IconCheck, IconCorazon } from './Icons';
import { Enfasis } from './Enfasis';

function dolares(cents) {
  const c = Number(cents) || 0;
  const dec = c % 100 ? 2 : 0;
  return `$${(c / 100).toLocaleString('en', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

// Barra de lo donado frente a la meta que fija el admin; sin meta no se pinta.
function Meta({ donaciones }) {
  const t = useT('plans');
  const { total_cents: total, goal_cents: meta } = donaciones;
  if (!meta) return null;
  const pct = Math.min(100, Math.round((total / meta) * 100));
  return (
    <div className="donaciones__meta">
      <div className="donaciones__meta-cabeza">
        <span className="donaciones__eyebrow">{t('donGoalEyebrow')}</span>
        <span className="donaciones__meta-cifra">{t('donGoalOf', { raised: dolares(total), goal: dolares(meta) })}</span>
      </div>
      <div className="donaciones__barra" role="progressbar" aria-label={t('donGoalAria')}
        aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// El selector de importe y el botón de PayPal, como el de founder pero aquí.
function SelectorDonativo({ cuenta }) {
  const t = useT('plans');
  const [monto, setMonto] = useState(10);
  const [otro, setOtro] = useState('');
  const esOtro = monto === 'otro';
  const final = esOtro ? Number(String(otro).replace(',', '.')) || null : monto;
  const url = urlPaypal(cuenta, final);
  return (
    <div className="donaciones__selector">
      <span className="donaciones__eyebrow">{t('donAmountLabel')}</span>
      <div className="donaciones__montos" role="group" aria-label={t('donAmountLabel')}>
        {[...MONTOS, 'otro'].map((v) => (
          <button key={v} type="button" className="donaciones__monto" aria-pressed={monto === v} onClick={() => setMonto(v)}>
            {v === 'otro' ? t('donOther') : `$${v}`}
          </button>
        ))}
      </div>
      {esOtro && (
        <label className="donaciones__otro">
          {t('donOtherLabel')}
          <input type="number" min="1" inputMode="decimal" value={otro} onChange={(e) => setOtro(e.target.value)} />
        </label>
      )}
      {url ? (
        <a className="pill pill--oliva" href={url} target="_blank" rel="noopener noreferrer">
          <IconCorazon size={17} />{t('donWithPaypal', { amount: final ? `$${final}` : '' })}
        </a>
      ) : (
        <button type="button" className="pill pill--oliva" disabled>{t('donUnavailable')}</button>
      )}
      <p className="donaciones__nota">{t('donSecure')}</p>
    </div>
  );
}

// Lo que ve /plans mientras las donaciones sustituyen a las suscripciones. Se
// dona aquí mismo: el botón lleva a PayPal con el importe elegido.
export function PaginaDonaciones({ donaciones, conCuenta }) {
  const t = useT('plans');
  const locale = useLocale();
  return (
    <div className="donaciones">
      <header className="donaciones__cabeza">
        <p className="donaciones__eyebrow">{t('donEyebrow')}</p>
        <h1 className="donaciones__titulo"><Enfasis texto={t('donTitle')} /></h1>
        <p className="donaciones__lead">{t('donLead')}</p>
      </header>

      <div className="donaciones__rejilla">
        <article className="donaciones__cuenta">
          <span className="donaciones__eyebrow">{t('donFreeEyebrow')}</span>
          <p className="donaciones__precio">{t('donFree')} <span>{t('donFreeSub')}</span></p>
          <ul>
            {t('donIncluded').map((r) => <li key={r}><IconCheck size={17} />{r}</li>)}
          </ul>
          {!conCuenta && <Link to="/auth?mode=register" className="pill pill--tinta">{t('donStart')}</Link>}
        </article>

        <article className="donaciones__donar">
          <span className="donaciones__eyebrow">{t('donCardEyebrow')}</span>
          <p className="donaciones__frase"><Enfasis texto={t('donCardTitle')} /></p>
          <Meta donaciones={donaciones} />
          <SelectorDonativo cuenta={donaciones.paypal_business} />
          <a href={urlFounder('/donate', locale)} className="donaciones__enlace">{t('donWhere')} →</a>
        </article>
      </div>
    </div>
  );
}

// La tarjeta de Ajustes › Facturación cuando no hay suscripción de pago.
export function TarjetaAportes() {
  const t = useT('plans');
  const locale = useLocale();
  return (
    <div className="set-card set-aportes">
      <span className="donaciones__eyebrow">{t('donSettingsEyebrow')}</span>
      <p className="donaciones__frase"><Enfasis texto={t('donCardTitle')} /></p>
      <p className="donaciones__texto">{t('donSettingsText')}</p>
      <div className="set-aportes__botones">
        <Link to="/plans" className="pill pill--oliva"><IconCorazon size={16} />{t('donButton')}</Link>
        <a href={urlFounder('/donate', locale)} className="donaciones__enlace">{t('donWhere')} →</a>
      </div>
    </div>
  );
}
