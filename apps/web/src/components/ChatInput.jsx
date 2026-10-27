// Las imágenes las describe un modelo de visión y viajan como contexto, así que
// valen con cualquier modelo. El audio no se acepta: el gateway no transcribe.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconClip, IconFile, IconGlobe, IconImage, IconMic, IconSend, IconStop, IconX,
} from './Icons';
import { AvisoCuota, Razonamiento } from './Razonamiento';
import { ContextoUso } from './ContextoUso';
import { Select } from './Select';
import { useDictado } from '../hooks/useDictado';
import { useT } from '../i18n/useT';
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

export function ChatInput({ onSend, onStop, busy, models, modelInfo = {}, model, onModelChange, webSearch, onToggleWeb, contextUso, modelVision = false, placeholder, initialText = '', tools = null,
  nivelesRazonar = [], razonar = 'auto', onRazonar, avisoCuota = null, onCerrarAviso, commands = [] }) {
  const t = useT('chat');
  const ref = useRef(null);
  const fileRef = useRef(null);
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState('');
  const [arrastrando, setArrastrando] = useState(false);
  const [filtro, setFiltro] = useState(null);
  const sugerencias = filtro === null ? [] : commands.filter((c) => c.cmd.startsWith(filtro.toLowerCase()));

  const leyendo = attachments.some((a) => a.estado === 'leyendo');

  // Se mide con la altura en `auto` y se restaura antes de pintar para que la
  // transición parta del alto anterior y no de cero.
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

  useEffect(() => {
    if (!initialText || !ref.current) return;
    ref.current.value = initialText;
    ajustarAlto();
    ref.current.focus();
    ref.current.setSelectionRange(initialText.length, initialText.length);
  }, [initialText, ajustarAlto]);

  const dictado = useDictado(
    useCallback((texto) => {
      const el = ref.current;
      if (!el) return;
      el.value = el.value ? `${el.value.replace(/\s+$/, '')} ${texto}` : texto;
      ajustarAlto();
      el.focus();
    }, [ajustarAlto]),
  );

  const anadirArchivos = useCallback(async (archivos) => {
    const lista = Array.from(archivos || []);
    if (lista.length === 0) return;
    setError('');

    for (const file of lista) {
      if (esAudioOVideo(file)) {
        setError(t('audioVideoError'));
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
        if (modelVision) {
          // El modelo elegido ve: la imagen va tal cual con el mensaje, sin
          // pasar por el sub-agente de descripción.
          setAttachments((prev) => [...prev, {
            id, kind: 'image', filename: nombre, preview: preparada.dataUrl,
            base64: preparada.base64, text: '', estado: 'listo',
          }]);
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
  }, [modelVision, t]);

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
    if (archivos.length === 0) return;
    e.preventDefault();
    anadirArchivos(archivos);
  };

  const quitar = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const send = () => {
    const el = ref.current;
    const text = el.value.trim();
    const listos = attachments.filter((a) => a.estado === 'listo');
    if ((!text && listos.length === 0) || busy || leyendo) return;

    let payload = text;
    const nativas = listos.filter((a) => a.base64);
    const descritos = listos.filter((a) => !a.base64);
    if (descritos.length > 0) {
      const contexto = descritos.map(contextoDe).join('\n\n');
      const pregunta = text || (descritos.some((a) => a.kind === 'image')
        ? t('analyzeImage')
        : t('analyzeDocument'));
      payload = `${contexto}\n\n---\n\n${pregunta}`;
    } else if (!text && nativas.length > 0) {
      payload = t('analyzeImage');
    }

    el.value = '';
    setFiltro(null);
    el.style.height = '';
    el.style.overflowY = 'hidden';
    setAttachments([]);
    onSend(payload, nativas.map((a) => a.base64));
  };

  const alEscribir = () => {
    ajustarAlto();
    const valor = ref.current?.value || '';
    setFiltro(commands.length && /^\/\S*$/.test(valor) ? valor : null);
  };

  const completar = (cmd) => {
    const el = ref.current;
    el.value = `${cmd} `;
    setFiltro(null);
    ajustarAlto();
    el.focus();
  };

  const onKeyDown = (e) => {
    if (sugerencias.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault();
      completar(sugerencias[0].cmd);
      return;
    }
    if (filtro !== null && e.key === 'Escape') {
      setFiltro(null);
      return;
    }
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
      <AvisoCuota aviso={avisoCuota} onCerrar={onCerrarAviso} />
      <div className="chat-input__box">
      {arrastrando && (
        <div className="chat-drop" role="status">
          <div className="chat-drop__caja">
            <IconClip size={22} />
            <span>{t('dropHint')}</span>
            <small>{t('dropHintSmall')}</small>
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="chat-input__chips">
          {attachments.map((a) => (
            <span
              key={a.id}
              className={a.estado === 'leyendo' ? 'attach-chip is-loading' : 'attach-chip'}
              title={a.truncated ? t('truncatedTitle') : a.filename}
            >
              {a.kind === 'image' && a.preview
                ? <img className="attach-chip__thumb" src={a.preview} alt="" />
                : a.kind === 'image' ? <IconImage size={13} /> : <IconFile size={13} />}
              <span className="attach-chip__name">{a.filename}</span>
              {a.estado === 'leyendo' && (
                <span className="attach-chip__trunc">
                  {a.kind === 'image' ? t('readingImage') : t('reading')}
                </span>
              )}
              {a.truncated && a.estado === 'listo' && (
                <span className="attach-chip__trunc">{t('truncated')}</span>
              )}
              <button
                className="attach-chip__x"
                onClick={() => quitar(a.id)}
                aria-label={t('removeAttachment', { name: a.filename })}
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {aviso && <div className="chat-input__error">{aviso}</div>}

      {sugerencias.length > 0 && (
        <ul className="chat-cmds" role="listbox" aria-label={t('commandsAria')}>
          {sugerencias.map((c) => (
            <li key={c.cmd}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => completar(c.cmd)}>
                <strong>{c.cmd}</strong>
                <span>{c.desc}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={ref}
        className="chat-input__text"
        placeholder={placeholder || t('inputPlaceholder')}
        rows={1}
        onKeyDown={onKeyDown}
        onInput={alEscribir}
        onPaste={alPegar}
        aria-label={t('messageAriaLabel')}
      />

      <div className="chat-input__bar">
      <div className="chat-input__tools">
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
          title={t('attachTitle')}
          onClick={() => fileRef.current?.click()}
        >
          <IconClip size={19} />
        </button>
        {dictado.soportado && (
          <button
            className={dictado.escuchando ? 'icon-btn is-recording' : 'icon-btn'}
            type="button"
            title={dictado.escuchando ? t('dictateStop') : t('dictateStart')}
            onClick={dictado.alternar}
            aria-pressed={dictado.escuchando}
          >
            <IconMic size={19} />
          </button>
        )}
        <button
          className={webSearch ? 'icon-btn is-active' : 'icon-btn'}
          type="button"
          title={onToggleWeb ? (webSearch ? t('webSearchOnTitle') : t('webSearchOffTitle')) : t('webSearchSoonTitle')}
          onClick={onToggleWeb}
          disabled={!onToggleWeb}
          aria-pressed={webSearch}
        >
          <IconGlobe size={19} />
        </button>
        {tools && <span className="chat-input__sep" />}
        {tools}
      </div>

      {models.length > 0 && (
        <div className="chat-input__meta">
          <Select
            className="chat-input__model"
            value={model}
            options={models.map((m) => ({ value: m, label: modelInfo[m]?.name || m }))}
            onChange={onModelChange}
            aria-label={t('modelAriaLabel')}
          />
          {onRazonar && <Razonamiento niveles={nivelesRazonar} valor={razonar} onChange={onRazonar} />}
          <ContextoUso uso={contextUso} />
        </div>
      )}

      {busy && onStop ? (
        <button
          className="chat-input__send is-stop"
          type="button"
          onClick={onStop}
          aria-label={t('stopResponse')}
          title={t('stopResponse')}
        >
          <IconStop size={19} />
        </button>
      ) : (
        <button
          className="chat-input__send"
          type="button"
          onClick={send}
          disabled={busy || leyendo}
          aria-label={t('sendAriaLabel')}
        >
          <IconSend size={19} />
        </button>
      )}
      </div>
      </div>
    </div>
  );
}
