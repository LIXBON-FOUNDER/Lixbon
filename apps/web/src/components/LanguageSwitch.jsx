// LanguageSwitch.jsx — selector de idioma (no un interruptor ciego): al pulsar
// se abre un menú con "Español" e "English" y se navega a la opción elegida,
// conservando la página actual. Los nombres de los idiomas nunca se traducen
// (un hispanohablante debe poder reconocer "English" tal cual).
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLocale } from '../i18n/LocaleContext';
import { useT } from '../i18n/useT';
import { useDismiss } from '../hooks/useDismiss';
import { otherLocalePath } from '../i18n/paths';
import { Desplegable } from './Desplegable';
import { IconGlobe, IconCheck } from './Icons';

const OPTIONS = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
];

export function LanguageSwitch({ className = 'icon-btn' }) {
  const locale = useLocale();
  const t = useT('nav');
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(open, ref, () => setOpen(false));

  const elegir = (code) => {
    setOpen(false);
    if (code === locale) return;
    // Solo hay dos idiomas: si no es el actual, es el otro. El slug es el
    // mismo en los dos — alcanza con anteponer o quitar /en.
    navigate(`${otherLocalePath(pathname)}${search}${hash}`);
  };

  return (
    <div className="lang-switch" ref={ref}>
      <button
        type="button"
        className={className}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('language')}
      >
        <IconGlobe size={16} />
      </button>
      <Desplegable abierto={open} className="lang-switch__menu" role="listbox" aria-label={t('language')}>
        {OPTIONS.map((o) => (
          <button
            key={o.code}
            type="button"
            role="option"
            aria-selected={o.code === locale}
            className={`lang-switch__opt ${o.code === locale ? 'is-active' : ''}`}
            onClick={() => elegir(o.code)}
          >
            <span>{o.label}</span>
            {o.code === locale && <IconCheck size={14} />}
          </button>
        ))}
      </Desplegable>
    </div>
  );
}
