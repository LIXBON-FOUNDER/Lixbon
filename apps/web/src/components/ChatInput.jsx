// ChatInput.jsx — caja de input del chat. Adjuntar documentos (PDF/texto/código)
// y toggle de búsqueda web. El micrófono sigue oculto (decisión v1).
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { IconClip, IconGlobe, IconSend, IconX } from './Icons';

const ACCEPT = '.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.py,.js,.jsx,.ts,.tsx,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.log,text/*,application/pdf';

export function ChatInput({ onSend, busy, models, model, onModelChange, webSearch, onToggleWeb }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const [attachments, setAttachments] = useState([]); // {filename, text, chars, truncated}
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const send = () => {
    const text = ref.current.value.trim();
    if ((!text && attachments.length === 0) || busy) return;
    // El contexto de los documentos se antepone al mensaje enviado al modelo.
    let payload = text;
    if (attachments.length > 0) {
      const docs = attachments
        .map((a) => `--- Documento adjunto: ${a.filename} ---\n${a.text}`)
        .join('\n\n');
      payload = `${docs}\n\n---\n\n${text || 'Analiza el documento adjunto.'}`;
    }
    ref.current.value = '';
    ref.current.style.height = 'auto';
    setAttachments([]);
    onSend(payload);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  const pickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setError('');
    setUploading(true);
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await api.post('/api/attachments', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        setAttachments((prev) => [...prev, res.data]);
      } catch (err) {
        const d = err.response?.data?.detail;
        setError((d && d.message) || `No se pudo adjuntar ${file.name}`);
      }
    }
    setUploading(false);
  };

  const removeAttachment = (i) => setAttachments((prev) => prev.filter((_, j) => j !== i));

  return (
    <div className="chat-input">
      {attachments.length > 0 && (
        <div className="chat-input__chips">
          {attachments.map((a, i) => (
            <span key={i} className="attach-chip" title={a.truncated ? 'Documento recortado por longitud' : a.filename}>
              <IconClip size={13} />
              <span className="attach-chip__name">{a.filename}</span>
              {a.truncated && <span className="attach-chip__trunc">recortado</span>}
              <button className="attach-chip__x" onClick={() => removeAttachment(i)} aria-label={`Quitar ${a.filename}`}>
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="chat-input__error">{error}</div>}

      <textarea
        ref={ref}
        className="chat-input__text"
        placeholder="Pregunta lo que quieras"
        rows={1}
        onKeyDown={onKeyDown}
        onInput={autoGrow}
        aria-label="Mensaje"
      />
      <div className="chat-input__bar">
        <div className="chat-input__left">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={pickFiles}
            style={{ display: 'none' }}
          />
          <button
            className="icon-btn"
            type="button"
            title="Adjuntar documento (PDF, texto, código)"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            <IconClip />
          </button>
          <button
            className={`icon-btn ${webSearch ? 'is-active' : ''}`}
            type="button"
            title={onToggleWeb ? (webSearch ? 'Búsqueda en internet activada' : 'Buscar en internet') : 'Buscar en la web (próximamente)'}
            onClick={onToggleWeb}
            disabled={!onToggleWeb}
            aria-pressed={webSearch}
          >
            <IconGlobe />
          </button>
          {models.length > 0 && (
            <select
              className="chat-input__model"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              aria-label="Modelo"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
        <button
          className="chat-input__send"
          type="button"
          onClick={send}
          disabled={busy || uploading}
          aria-label="Enviar"
        >
          <IconSend size={16} />
        </button>
      </div>
    </div>
  );
}
