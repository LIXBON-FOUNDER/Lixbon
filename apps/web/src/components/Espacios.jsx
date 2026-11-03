// Piezas de Espacios y Agentes: el estado con icono, las ventanas de crear y
// editar (espacio, instrucciones, agente) y el texto del horario.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icono, IconX } from './Icons';
import { useCierreAnimado } from '../hooks/useCierreAnimado';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { ICONO_ESTADO, crearAgente, crearEspacio, editarAgente, editarEspacio, errorDe, zonaLocal } from '../lib/espacios';
import '../styles/espacios.css';

/** Estado solo con icono; el texto va en el tooltip y en el lector de pantalla. */
export function Estado({ estado }) {
  const t = useT('espacios');
  if (!estado || !ICONO_ESTADO[estado]) return null;
  const etiqueta = t(`state_${estado}`);
  return (
    <span className={`esp-estado esp-estado--${estado}`} role="img" aria-label={etiqueta} title={etiqueta}>
      <Icono nombre={ICONO_ESTADO[estado]} size={18} />
    </span>
  );
}

export function Baldosa({ icono, grande = false }) {
  return <span className={`esp-baldosa ${grande ? 'esp-baldosa--grande' : ''}`}><Icono nombre={icono} size={18} /></span>;
}

/** «Lun, mié y vie · 10:00», «Cada día · 19:00». */
export function useHorario() {
  const t = useT('espacios');
  const locale = useLocale();
  return (ag) => {
    const dias = [...(ag.dias || [])].sort();
    let texto;
    if (dias.length === 7) texto = t('everyDay');
    else if (dias.join() === '0,1,2,3,4') texto = t('weekdays');
    else {
      const largos = t('dayLong');
      const nombres = dias.map((d) => largos[d].slice(0, 3));
      const lista = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(nombres);
      texto = lista.charAt(0).toUpperCase() + lista.slice(1);
    }
    return t('at', { dias: texto, hora: ag.hora });
  };
}

/** Fecha corta relativa: «hoy · 10:00», «mié · 10:00», «28 oct». */
export function useFechaCorta() {
  const locale = useLocale();
  return (iso) => {
    if (!iso) return '';
    const f = new Date(iso);
    const hoy = new Date();
    const hora = f.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const dias = Math.round((new Date(hoy.toDateString()) - new Date(f.toDateString())) / 86400000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (dias === 0 || dias === 1 || dias === -1) {
      const d = rtf.format(-dias, 'day');
      return `${d.charAt(0).toUpperCase()}${d.slice(1)} · ${hora}`;
    }
    if (Math.abs(dias) < 7) {
      const d = f.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '');
      return `${d.charAt(0).toUpperCase()}${d.slice(1)} · ${hora}`;
    }
    return f.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  };
}

/** Ventana sobre la interfaz, con el cierre animado del resto de modales. */
export function Ventana({ titulo, desc, ancho = false, children, acciones, onClose, ocupado = false }) {
  const tc = useT('common');
  const { cerrando, cerrar } = useCierreAnimado(onClose, { bloqueado: ocupado });
  return createPortal(
    <div className={cerrando ? 'modal-overlay is-closing' : 'modal-overlay'} onClick={cerrar}>
      <div className={`modal esp-modal ${ancho ? 'esp-modal--ancho' : ''}`} role="dialog" aria-modal="true"
        aria-label={titulo} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') cerrar(); }}>
        <div className="modal__head">
          <h2 className="modal__title">{titulo}</h2>
          <button type="button" className="icon-btn" onClick={cerrar} aria-label={tc('close')} disabled={ocupado}><IconX /></button>
        </div>
        {desc && <p className="card__muted modal__desc">{desc}</p>}
        {children}
        {acciones && <div className="modal__actions">{acciones(cerrar)}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Crear un espacio o cambiarle el nombre y la descripción. */
export function VentanaEspacio({ espacio = null, onClose, onListo }) {
  const t = useT('espacios');
  const tc = useT('common');
  const [nombre, setNombre] = useState(espacio?.nombre || '');
  const [descripcion, setDescripcion] = useState(espacio?.descripcion || '');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  const guardar = async (cerrar) => {
    if (!nombre.trim()) return;
    setOcupado(true);
    setError('');
    try {
      const cuerpo = { nombre: nombre.trim(), descripcion: descripcion.trim() };
      const r = espacio ? await editarEspacio(espacio.id, cuerpo) : await crearEspacio(cuerpo);
      setOcupado(false);
      onListo?.(r);
      cerrar();
    } catch (e) {
      setError(errorDe(e, t('loadError')));
      setOcupado(false);
    }
  };

  return (
    <Ventana titulo={espacio ? t('editSpace') : t('newSpace')} onClose={onClose} ocupado={ocupado}
      acciones={(cerrar) => (
        <>
          <button type="button" className="pill-btn pill-btn--outline" onClick={cerrar} disabled={ocupado}>{tc('cancel')}</button>
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => guardar(cerrar)} disabled={ocupado || !nombre.trim()}>
            {espacio ? t('save') : t('create')}
          </button>
        </>
      )}>
      <form className="esp-campos" onSubmit={(e) => e.preventDefault()}>
        <label className="esp-campo">{t('nameLabel')}
          <input className="set-input" autoFocus maxLength={80} value={nombre} placeholder={t('namePlaceholder')}
            onChange={(e) => setNombre(e.target.value)} />
        </label>
        <label className="esp-campo">{t('descLabel')}
          <input className="set-input" maxLength={300} value={descripcion} placeholder={t('descPlaceholder')}
            onChange={(e) => setDescripcion(e.target.value)} />
        </label>
        {error && <p className="esp-error" role="alert">{error}</p>}
      </form>
    </Ventana>
  );
}

export function VentanaInstrucciones({ espacio, onClose, onListo }) {
  const t = useT('espacios');
  const tc = useT('common');
  const [texto, setTexto] = useState(espacio.instrucciones || '');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const guardar = async (cerrar) => {
    setOcupado(true);
    setError('');
    try {
      const r = await editarEspacio(espacio.id, { instrucciones: texto });
      setOcupado(false);
      onListo?.(r);
      cerrar();
    } catch (e) {
      setError(errorDe(e, t('loadError')));
      setOcupado(false);
    }
  };
  return (
    <Ventana titulo={t('instructions')} desc={t('instructionsHint')} ancho onClose={onClose} ocupado={ocupado}
      acciones={(cerrar) => (
        <>
          <button type="button" className="pill-btn pill-btn--outline" onClick={cerrar} disabled={ocupado}>{tc('cancel')}</button>
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => guardar(cerrar)} disabled={ocupado}>{t('save')}</button>
        </>
      )}>
      <textarea className="set-input esp-textarea" style={{ minHeight: 220 }} autoFocus maxLength={8000}
        aria-label={t('instructions')} placeholder={t('instructionsPlaceholder')} value={texto}
        onChange={(e) => setTexto(e.target.value)} />
      {error && <p className="esp-error" role="alert">{error}</p>}
    </Ventana>
  );
}

/** Crear o editar un agente: tarea, horario y herramientas. */
export function VentanaAgente({ espacio, agente = null, onClose, onListo }) {
  const t = useT('espacios');
  const tc = useT('common');
  const [nombre, setNombre] = useState(agente?.nombre || '');
  const [tarea, setTarea] = useState(agente?.tarea || '');
  const [dias, setDias] = useState(agente?.dias || [0, 2, 4]);
  const [hora, setHora] = useState(agente?.hora || '10:00');
  const [internet, setInternet] = useState(agente?.internet || false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const cortos = t('dayShort');
  const largos = t('dayLong');
  const valido = nombre.trim() && tarea.trim() && dias.length && /^\d{2}:\d{2}$/.test(hora);

  const alternar = (d) => setDias((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d].sort()));

  const guardar = async (cerrar) => {
    if (!valido) return;
    setOcupado(true);
    setError('');
    const cuerpo = { nombre: nombre.trim(), tarea: tarea.trim(), dias, hora, internet,
      zona: agente?.zona && agente.zona !== 'UTC' ? agente.zona : zonaLocal() };
    try {
      const r = agente ? await editarAgente(agente.id, cuerpo) : await crearAgente(espacio.id, cuerpo);
      setOcupado(false);
      onListo?.(r);
      cerrar();
    } catch (e) {
      setError(errorDe(e, t('loadError')));
      setOcupado(false);
    }
  };

  return (
    <Ventana ancho titulo={agente ? t('agentEditTitle') : t('agentNewTitle')}
      desc={t('agentDesc', { espacio: espacio.nombre })} onClose={onClose} ocupado={ocupado}
      acciones={(cerrar) => (
        <>
          <button type="button" className="pill-btn pill-btn--outline" onClick={cerrar} disabled={ocupado}>{tc('cancel')}</button>
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => guardar(cerrar)} disabled={ocupado || !valido}>
            {agente ? t('save') : t('createAgent')}
          </button>
        </>
      )}>
      <div className="esp-campos">
        <section className="esp-bloque">
          <h3><Icono nombre="agente" size={16} />{t('agentName')}</h3>
          <input className="set-input" style={{ width: '100%', maxWidth: 'none' }} autoFocus maxLength={80}
            aria-label={t('agentName')} placeholder={t('agentNamePlaceholder')} value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </section>
        <section className="esp-bloque">
          <h3><Icono nombre="texto" size={16} />{t('task')}</h3>
          <textarea className="set-input esp-textarea" maxLength={4000} aria-label={t('task')}
            placeholder={t('taskPlaceholder')} value={tarea} onChange={(e) => setTarea(e.target.value)} />
        </section>
        <section className="esp-bloque">
          <h3><Icono nombre="reloj" size={16} />{t('schedule')}</h3>
          <div className="esp-control">
            <span className="esp-control__texto">{t('days')}</span>
            <span className="set-seg" role="group" aria-label={t('days')}>
              {cortos.map((c, d) => (
                <button key={d} type="button" className={dias.includes(d) ? 'is-on' : ''} aria-pressed={dias.includes(d)}
                  aria-label={largos[d]} title={largos[d]} onClick={() => alternar(d)}>{c}</button>
              ))}
            </span>
          </div>
          <div className="esp-control">
            <span className="esp-control__texto">{t('time')}<small>{(agente?.zona && agente.zona !== 'UTC' ? agente.zona : zonaLocal()).replace(/_/g, ' ')}</small></span>
            <input type="time" className="set-input esp-hora" aria-label={t('time')} value={hora} onChange={(e) => setHora(e.target.value)} />
          </div>
        </section>
        <section className="esp-bloque">
          <h3><Icono nombre="deslizadores" size={16} />{t('tools')}</h3>
          <div className="esp-control">
            <span className="esp-control__texto">{t('internet')}<small>{t('internetHint')}</small></span>
            <button type="button" className={`set-toggle ${internet ? 'is-on' : ''}`} role="switch" aria-checked={internet}
              aria-label={t('internet')} onClick={() => setInternet((v) => !v)}><span className="set-toggle__knob" /></button>
          </div>
        </section>
        {error && <p className="esp-error" role="alert">{error}</p>}
      </div>
    </Ventana>
  );
}
