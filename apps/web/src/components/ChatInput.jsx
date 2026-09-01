// ChatInput.jsx — caja de escritura del chat.
//
// Un archivo entra por tres puertas, y las tres acaban en la misma función:
// el clip, pegar con Ctrl+V y soltarlo sobre la ventana. Documentos (PDF,
// Word, texto y código) se leen en el servidor; las imágenes las describe un modelo de
// visión y esa descripción viaja como contexto, así que valen con cualquier
// modelo. El audio no se acepta todavía: el gateway no transcribe, y decirlo es
// mejor que adjuntar algo que el modelo nunca va a leer. Para hablar en vez de
// escribir está el micrófono, que dicta en el propio navegador.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconClip, IconFile, IconGlobe, IconImage, IconMic, IconSend, IconX,
} from './Icons';
import { useDictado } from '../hooks/useDictado';
import {
  contextoDe, describirImagen, esAudioOVideo, esImagen, mensajeDeError,
  prepararImagen, subirDocumento,
} from '../lib/adjuntos';

const ACCEPT = [
  'image/*',
  '.pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.py,.js,.jsx,.ts,.tsx',
  '.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.log,text/*,application/pdf',
].join(',');

const ALTO_MAX = 180;

let siguienteId = 0;

export function ChatInput({ onSend, busy, models, model, onModelChange, webSearch, onToggleWeb }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState('');
  const [arrastrando, setArrastrando] = useState(false);

  const leyendo = attachments.some((a) => a.estado === 'leyendo');

  // ── Crecer con lo escrito ───────────────────────────────────────────
  // Se mide con la altura en `auto` y se restaura antes de que el navegador
  // pinte, para que la transición de CSS salga del alto anterior y no de cero:
  // sin esto la caja da un salto seco cada vez que el texto pasa de línea.
  const ajustarAlto = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const previo = el.style.height;
    el.style.height = 'auto';
    const objetivo = Math.min(el.scrollHeight, ALTO_MAX);
    el.style.height = previo || '0px';
    void el.offsetHeight; // fija el punto de partida de la transición
    el.style.height = `${objetivo}px`;
    el.style.overflowY = el.scrollHeight > ALTO_MAX ? 'auto' : 'hidden';
  }, []);

  const dictado = useDictado(
    useCallback((texto) => {
      const el = ref.current;
      if (!el) return;
      el.value = el.value ? `${el.value.replace(/\s+$/, '')} ${texto}` : texto;
      ajustarAlto();
      el.focus();
    }, [ajustarAlto]),
  );

  // ── Adjuntar ────────────────────────────────────────────────────────

  const anadirArchivos = useCallback(async (archivos) => {
    const lista = Array.from(archivos || []);
    if (lista.length === 0) return;
    setError('');

    for (const file of lista) {
      if (esAudioOVideo(file)) {
        setError('Todavía no se puede adjuntar audio ni vídeo: usa el micrófono para dictar.');
        continue;
      }

      const id = (siguienteId += 1);
      const nombre = file.name || (esImagen(file) ? 'imagen.png' : 'documento');

      if (esImagen(file)) {
        // La miniatura aparece antes de que el modelo la mire: adjuntar una
        // imagen y no ver nada durante varios segundos parece que falló.
        let preparada;
        try {
          preparada = await prepararImagen(file);
        } catch (err) {
          setError(mensajeDeError(err, nombre));
          continue;
        }
        setAttachments((prev) => [...prev, {
          id, kind: 'image', filename: nombre, preview: preparada.dataUrl,
          text: '', estado: 'leyendo',
        }]);
        try {
          const descripcion = await describirImagen(preparada.base64);
          setAttachments((prev) => prev.map((a) => (
            a.id === id ? { ...a, text: descripcion, estado: 'listo' } : a
          )));
        } catch (err) {
          setError(mensajeDeError(err, nombre));
          setAttachments((prev) => prev.filter((a) => a.id !== id));
        }
        continue;
      }

      setAttachments((prev) => [...prev, {
        id, kind: 'doc', filename: nombre, text: '', estado: 'leyendo',
      }]);
      try {
        const doc = await subirDocumento(file);
        setAttachments((prev) => prev.map((a) => (
          a.id === id ? { ...a, ...doc, kind: 'doc', estado: 'listo' } : a
        )));
      } catch (err) {
        setError(mensajeDeError(err, nombre));
        setAttachments((prev) => prev.filter((a) => a.id !== id));
      }
    }
  }, []);

  // Soltar en cualquier punto de la ventana, no solo sobre la caja: quien
  // arrastra un archivo apunta al chat, no a un rectángulo de 40 píxeles.
  useEffect(() => {
    let dentro = 0;

    const entra = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dentro += 1;
      setArrastrando(true);
    };
    const sale = () => {
      dentro = Math.max(0, dentro - 1);
      if (dentro === 0) setArrastrando(false);
    };
    const encima = (e) => {
      // Sin esto el navegador abre el archivo en la pestaña y se pierde el chat.
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    const suelta = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      dentro = 0;
      setArrastrando(false);
      anadirArchivos(e.dataTransfer.files);
    };

    window.addEventListener('dragenter', entra);
    window.addEventListener('dragleave', sale);
    window.addEventListener('dragover', encima);
    window.addEventListener('drop', suelta);
    return () => {
      window.removeEventListener('dragenter', entra);
      window.removeEventListener('dragleave', sale);
      window.removeEventListener('dragover', encima);
      window.removeEventListener('drop', suelta);
    };
  }, [anadirArchivos]);

  const alPegar = (e) => {
    const archivos = Array.from(e.clipboardData?.files || []);
    if (archivos.length === 0) return; // pegar texto sigue siendo pegar texto
    e.preventDefault();
    anadirArchivos(archivos);
  };

  const quitar = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // ── Enviar ──────────────────────────────────────────────────────────

  const send = () => {
    const el = ref.current;
    const text = el.value.trim();
    const listos = attachments.filter((a) => a.estado === 'listo');
    if ((!text && listos.length === 0) || busy || leyendo) return;

    let payload = text;
    if (listos.length > 0) {
      const contexto = listos.map(contextoDe).join('\n\n');
      const pregunta = text || (listos.some((a) => a.kind === 'image')
        ? 'Analiza la imagen adjunta.'
        : 'Analiza el documento adjunto.');
      payload = `${contexto}\n\n---\n\n${pregunta}`;
    }

    el.value = '';
    el.style.height = '';
    el.style.overflowY = 'hidden';
    setAttachments([]);
    onSend(payload);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const pickFiles = (e) => {
    const archivos = e.target.files;
    e.target.value = '';
    anadirArchivos(archivos);
  };

  const aviso = error || dictado.error;

  return (
    <div className={arrastrando ? 'chat-input is-dropping' : 'chat-input'}>
      {arrastrando && (
        <div className="chat-drop" role="status">
          <div className="chat-drop__caja">
            <IconClip size={22} />
            <span>Suelta para adjuntar</span>
            <small>Imágenes, PDF, Word, texto y código</small>
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="chat-input__chips">
          {attachments.map((a) => (
            <span
              key={a.id}
              className={a.estado === 'leyendo' ? 'attach-chip is-loading' : 'attach-chip'}
              title={a.truncated ? 'Documento recortado por longitud' : a.filename}
            >
              {a.kind === 'image' && a.preview
                ? <img className="attach-chip__thumb" src={a.preview} alt="" />
                : a.kind === 'image' ? <IconImage size={13} /> : <IconFile size={13} />}
              <span className="attach-chip__name">{a.filename}</span>
              {a.estado === 'leyendo' && (
                <span className="attach-chip__trunc">
                  {a.kind === 'image' ? 'leyendo imagen…' : 'leyendo…'}
                </span>
              )}
              {a.truncated && a.estado === 'listo' && (
                <span className="attach-chip__trunc">recortado</span>
              )}
              <button
                className="attach-chip__x"
                onClick={() => quitar(a.id)}
                aria-label={`Quitar ${a.filename}`}
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {aviso && <div className="chat-input__error">{aviso}</div>}

      <textarea
        ref={ref}
        className="chat-input__text"
        placeholder="Pregunta lo que quieras"
        rows={1}
        onKeyDown={onKeyDown}
        onInput={ajustarAlto}
        onPaste={alPegar}
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
            title="Adjuntar imagen o documento (también puedes pegarlo o arrastrarlo)"
            onClick={() => fileRef.current?.click()}
          >
            <IconClip />
          </button>
          {dictado.soportado && (
            <button
              className={dictado.escuchando ? 'icon-btn is-recording' : 'icon-btn'}
              type="button"
              title={dictado.escuchando ? 'Parar el dictado' : 'Dictar el mensaje'}
              onClick={dictado.alternar}
              aria-pressed={dictado.escuchando}
            >
              <IconMic />
            </button>
          )}
          <button
            className={webSearch ? 'icon-btn is-active' : 'icon-btn'}
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
          disabled={busy || leyendo}
          aria-label="Enviar"
        >
          <IconSend size={16} />
        </button>
      </div>
    </div>
  );
}
