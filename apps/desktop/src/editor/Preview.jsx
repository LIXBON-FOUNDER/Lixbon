// Preview.jsx — vista previa en vivo de Markdown y HTML (D3). Aparece a la
// derecha del editor cuando se activa (para archivos .md / .html).
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import { IconX } from '../components/Icons';

function kindOf(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase();
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (['html', 'htm'].includes(ext)) return 'html';
  return '';
}

export function Preview() {
  const activePath = useEditorStore((s) => s.activePath);
  const docVersion = useEditorStore((s) => s.docVersion);
  const closePreview = () => useAppStore.getState().setPreviewOpen(false);

  const { name, content, kind } = useMemo(() => {
    const ctx = useEditorStore.getState().getActiveContext();
    if (!ctx) return { name: '', content: '', kind: '' };
    return { name: ctx.name, content: ctx.content, kind: kindOf(ctx.name) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, docVersion]);

  return (
    <div className="preview">
      <div className="preview__head">
        <span className="preview__title">Vista previa · {name || '—'}</span>
        <button className="icon-btn" onClick={closePreview} title="Cerrar vista previa">
          <IconX size={15} />
        </button>
      </div>
      <div className="preview__body">
        {kind === 'md' ? (
          <div className="preview__md chat-markdown">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : kind === 'html' ? (
          <iframe
            className="preview__frame"
            sandbox=""
            srcDoc={content}
            title="Vista previa HTML"
          />
        ) : (
          <p className="settings__hint" style={{ padding: '16px' }}>
            La vista previa solo admite Markdown (.md) y HTML (.html).
          </p>
        )}
      </div>
    </div>
  );
}
