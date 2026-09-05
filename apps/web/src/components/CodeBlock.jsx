// CodeBlock.jsx — bloque de comando con botón de copiar.
import { useState } from 'react';
import { IconCopy, IconCheck } from './Icons';

export function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  return (
    <div className="codeblock">
      {/* Cabecera: el lenguaje a la izquierda y el copiar a la derecha, fuera
          del camino del comando. */}
      <div className="codeblock__head">
        <span className="codeblock__label">{label}</span>
        <button className="codeblock__copy" onClick={copy} aria-label="Copiar comando">
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          <span>{copied ? 'Copiado' : 'Copiar'}</span>
        </button>
      </div>
      <div className="codeblock__row">
        <code className="codeblock__code">{code}</code>
      </div>
    </div>
  );
}
