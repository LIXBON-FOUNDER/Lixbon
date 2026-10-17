import { useT } from '../i18n/useT';

// La lámina nocturna de founder.lixbon.com, a la izquierda del acceso. Es una
// imagen (AVIF con WebP de respaldo, en public/laminas): pintar el SVG animado
// costaba más que descargar unos 100 KB. Va en carga diferida porque por debajo
// de 900 px la lámina se oculta y así el móvil no la descarga.
const ANCHOS = [560, 840, 1122];
const srcSet = (ext) => ANCHOS.map((a) => `/laminas/sierra-noche-acceso-${a}.${ext} ${a}w`).join(', ');

export function LaminaAuth() {
  const t = useT('auth');
  const [antes, resaltado, despues] = t('laminaFrase').split('*');
  return (
    <aside className="auth__lamina" aria-hidden="true">
      <picture className="auth__paisaje paisaje paisaje--noche" style={{ backgroundColor: '#423436' }}>
        <source type="image/avif" srcSet={srcSet('avif')} sizes="50vw" />
        <source type="image/webp" srcSet={srcSet('webp')} sizes="50vw" />
        <img src="/laminas/sierra-noche-acceso-840.webp" width={1122} height={1402} alt="" decoding="async" loading="lazy" />
      </picture>
      <div className="auth__lamina-texto">
        <span>{t('laminaPie')}</span>
        <p>{antes}<em>{resaltado}</em>{despues}</p>
      </div>
    </aside>
  );
}
