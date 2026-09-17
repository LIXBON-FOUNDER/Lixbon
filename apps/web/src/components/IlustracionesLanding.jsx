// IlustracionesLanding.jsx — dibujos de línea de la portada. Colores por
// variables CSS para que sigan al tema claro u oscuro.
import { useT } from '../i18n/useT';

const F = 'Geist, sans-serif';
const M = 'Geist Mono, monospace';

function Gpu({ x, y, titulo, sub, activo }) {
  const trazo = activo ? 'var(--accent)' : 'var(--trazo)';
  return (
    <g transform={`translate(${x} ${y})`} fontFamily={F}>
      <rect width="200" height="64" rx="8" fill="var(--surface-1)" stroke={trazo} strokeWidth="1.4" />
      <g transform="translate(16 18)" stroke={trazo} strokeWidth="1.3" fill="none">
        <rect width="28" height="28" rx="4" />
        <rect x="7" y="7" width="14" height="14" rx="2" />
        <path d="M9 0v-4M14 0v-4M19 0v-4M9 28v4M14 28v4M19 28v4M0 9h-4M0 14h-4M0 19h-4M28 9h4M28 14h4M28 19h4" />
      </g>
      <text x="60" y="28" fontSize="13" fontWeight="500" fill="var(--ink)">{titulo}</text>
      <text x="60" y="46" fontSize="11" fill="var(--ink-muted)" fontFamily={M}>{sub}</text>
    </g>
  );
}

export function IlustracionCluster() {
  const t = useT('illustrations');
  return (
    <svg className="landing__ilus" viewBox="0 0 1080 380" role="img" aria-label={t('clusterAriaLabel')}>
      <g fontFamily={F} fontSize="14" fill="var(--ink)">
        <circle cx="26" cy="70" r="4" fill="var(--trazo)" /><text x="44" y="75">{t('clusterChat')}</text>
        <circle cx="26" cy="140" r="4" fill="var(--trazo)" /><text x="44" y="145">{t('clusterVisuals')}</text>
        <circle cx="26" cy="210" r="4" fill="var(--trazo)" /><text x="44" y="215">{t('clusterCli')}</text>
        <circle cx="26" cy="280" r="4" fill="var(--trazo)" /><text x="44" y="285">{t('clusterApi')}</text>
      </g>
      <g stroke="var(--trazo)" strokeWidth="1.3" fill="none" opacity=".8">
        <path d="M230 70 C 330 70, 330 175, 400 175" />
        <path d="M230 140 C 330 140, 330 175, 400 175" />
        <path d="M230 210 C 330 210, 330 175, 400 175" />
        <path d="M230 280 C 330 280, 330 175, 400 175" />
      </g>
      <g transform="translate(400 115)">
        <rect width="190" height="120" rx="60" fill="var(--primary)" />
        <text x="95" y="55" textAnchor="middle" fontSize="15" fontWeight="500" fill="var(--on-primary)" fontFamily={F}>{t('clusterGateway')}</text>
        <text x="95" y="76" textAnchor="middle" fontSize="11.5" fill="var(--on-primary)" opacity=".7" fontFamily={M}>{t('clusterGatewaySub')}</text>
      </g>
      <g stroke="var(--trazo)" strokeWidth="1.3" fill="none" opacity=".8">
        <path d="M590 165 C 680 165, 680 58, 760 58" />
        <path d="M590 172 C 680 172, 680 138, 760 138" />
        <path d="M590 180 C 680 180, 680 218, 760 218" />
        <path d="M590 188 C 680 188, 680 298, 760 298" strokeDasharray="4 5" />
      </g>
      <Gpu x={760} y={26} titulo={t('gpuChatTitle')} sub="lixbon-1" activo />
      <Gpu x={760} y={106} titulo={t('gpuReasoningTitle')} sub="gpt-oss:120b" />
      <Gpu x={760} y={186} titulo={t('gpuVisionTitle')} sub="moondream" />
      <Gpu x={760} y={266} titulo={t('gpuCodeTitle')} sub="qwen2.5-coder" />
      <text x="26" y="358" fontSize="12.5" fill="var(--ink-muted)" fontFamily={F}>{t('clusterFooter')}</text>
    </svg>
  );
}

export function IlustracionPrivacidad() {
  const t = useT('illustrations');
  return (
    <svg className="landing__ilus" viewBox="0 0 560 360" role="img" aria-label={t('privacyAriaLabel')}>
      <g fontFamily={F} fontSize="13.5" fill="var(--ink)">
        <rect x="20" y="130" width="170" height="100" rx="8" fill="var(--surface-1)" stroke="var(--trazo)" strokeWidth="1.4" />
        <text x="40" y="162" fontWeight="500">{t('privacyYourMessage')}</text>
        <rect x="40" y="176" width="110" height="7" rx="3" fill="var(--relleno)" />
        <rect x="40" y="190" width="80" height="7" rx="3" fill="var(--relleno)" />
        <rect x="40" y="204" width="95" height="7" rx="3" fill="var(--relleno)" />
      </g>
      <path d="M190 180 L 340 180" stroke="var(--accent)" strokeWidth="1.6" fill="none" />
      <path d="M332 174 L 340 180 L 332 186" stroke="var(--accent)" strokeWidth="1.6" fill="none" />
      <g transform="translate(340 120)" fontFamily={F}>
        <rect width="200" height="120" rx="8" fill="var(--surface-1)" stroke="var(--accent)" strokeWidth="1.6" />
        <g transform="translate(20 22)" stroke="var(--ink)" strokeWidth="1.3" fill="none"><rect width="28" height="28" rx="4" /><rect x="7" y="7" width="14" height="14" rx="2" /></g>
        <text x="64" y="40" fontSize="13.5" fontWeight="500" fill="var(--ink)">{t('privacyGpu')}</text>
        <text x="64" y="58" fontSize="11.5" fill="var(--ink-muted)">{t('privacyGenerates')}</text>
        <text x="20" y="100" fontSize="11.5" fill="var(--ink-muted)">{t('privacyKeepsNothing')}</text>
        <g transform="translate(160 78)" stroke="var(--accent)" strokeWidth="1.4" fill="none"><rect x="0" y="8" width="18" height="14" rx="3" /><path d="M4 8V5a5 5 0 0 1 10 0v3" /></g>
      </g>
      <path d="M105 130 C 105 60, 300 40, 400 40" stroke="var(--ink-muted)" strokeWidth="1.3" strokeDasharray="5 6" fill="none" opacity=".7" />
      <g transform="translate(400 22)" fontFamily={F} fontSize="12.5" fill="var(--ink-muted)">
        <text x="0" y="14">{t('privacyProviders')}</text>
        <line x1="0" y1="26" x2="170" y2="26" stroke="var(--ink-muted)" strokeWidth="1.2" opacity=".6" />
      </g>
      <g transform="translate(340 30)" stroke="var(--ink-muted)" strokeWidth="1.6" fill="none"><circle cx="0" cy="10" r="10" /><path d="M-5 5l10 10M5 5l-10 10" /></g>
      <g fontFamily={F} fontSize="13" fill="var(--ink-soft)">
        <text x="20" y="300">{t('privacyHistory')}</text>
        <text x="20" y="322">{t('privacyNoTraining')}</text>
      </g>
    </svg>
  );
}
