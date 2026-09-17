// CodeBlock.jsx — bloque de comando con botón de copiar.
import { useState } from 'react';
import { IconCopy, IconCheck } from './Icons';
import { useT } from '../i18n/useT';

export function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);
  const t = useT('common');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  return (
    <div className="codeblock">
      {/* La etiqueta (cuando la hay) va en su propia línea, pegada al código;
          el botón de copiar vive junto al código para no dejar una cabecera
          casi vacía en los comandos de una sola línea. */}
      {label && (
        <div className="codeblock__head">
          <span className="codeblock__label">{label}</span>
        </div>
      )}
      <div className="codeblock__row">
        <code className="codeblock__code">{code}</code>
        <button className="codeblock__copy" onClick={copy} aria-label={t('copyCommand')}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          <span>{copied ? t('copied') : t('copy')}</span>
        </button>
      </div>
    </div>
  );
}
