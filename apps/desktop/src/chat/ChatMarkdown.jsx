// ChatMarkdown.jsx — markdown de las respuestas con bloques de código
// que se pueden copiar o insertar en el editor activo.
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useEditorStore } from '../store/editorStore';
import { IconCopy, IconCheck, IconSend } from '../components/Icons';

function CodeFence({ language, code }) {
  const [copied, setCopied] = useState(false);
  const [inserted, setInserted] = useState(false);
  const hasEditor = useEditorStore((s) => s.activePath !== null);
  const insertAtCursor = useEditorStore((s) => s.insertAtCursor);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard no disponible */ }
  };

  const insert = () => {
    if (insertAtCursor(code)) {
      setInserted(true);
      setTimeout(() => setInserted(false), 1800);
    }
  };

  return (
    <div className="chatcode">
      <div className="chatcode__bar">
        <span className="chatcode__lang">{language || 'código'}</span>
        <span className="chatcode__actions">
          <button onClick={copy} title="Copiar">
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
          <button
            onClick={insert}
            disabled={!hasEditor}
            title={hasEditor ? 'Insertar en el cursor del editor' : 'Abre un archivo para insertar'}
          >
            {inserted ? <IconCheck size={13} /> : <IconSend size={13} style={{ transform: 'rotate(90deg)' }} />}
            {inserted ? 'Insertado' : 'Insertar'}
          </button>
        </span>
      </div>
      <pre className="chatcode__pre"><code>{code}</code></pre>
    </div>
  );
}

const components = {
  code({ className, children }) {
    // react-markdown v10: los bloques ``` llegan como <pre><code class="language-x">.
    // El inline code no trae salto de línea ni language-.
    const text = String(children).replace(/\n$/, '');
    const match = /language-(\w+)/.exec(className || '');
    if (match || text.includes('\n')) {
      return <CodeFence language={match?.[1]} code={text} />;
    }
    return <code className="md-inline-code">{text}</code>;
  },
  pre({ children }) {
    return <>{children}</>; // CodeFence ya pinta su propio <pre>
  },
};

export function ChatMarkdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
