// «Mover a un espacio» desde la barra: el chat pasa a usar las instrucciones,
// archivos y memoria de ese espacio (o sale de él con «Sin espacio»).
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n/useT';
import { useNavigate } from '../i18n/link';
import { Icono, IconX } from './Icons';

export function MoverEspacio({ conv, onClose, onHecho }) {
  const t = useT('sidebar');
  const tc = useT('common');
  const navigate = useNavigate();
  const [espacios, setEspacios] = useState(null);
  const [elegido, setElegido] = useState(conv.espacio_id || null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/espacios').then((r) => setEspacios(Array.isArray(r.data) ? r.data : r.data.espacios || [])).catch(() => setEspacios([]));
  }, []);
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [onClose]);

  const guardar = async () => {
    setGuardando(true);
    setError('');
    try {
      await api.put(`/api/conversations/${conv.id}/espacio`, { espacio_id: elegido });
      onHecho();
    } catch (err) {
      setError(err.response?.data?.detail || t('sessionActionFailed'));
      setGuardando(false);
    }
  };

  const opcion = (id, nombre, icono) => (
    <button key={id || 'ninguno'} type="button" role="option" aria-selected={elegido === id}
      className={`cd-opcion ${elegido === id ? 'is-sel' : ''}`} onClick={() => setElegido(id)}>
      <Icono nombre={icono} size={16} /><span>{nombre}</span>
      {elegido === id && <Icono nombre="hecho" size={16} />}
    </button>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cd-modal cd-modal--estrecho" role="dialog" aria-modal="true" aria-labelledby="mv-t" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title" id="mv-t">{t('moveToSpace')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={tc('close')}><IconX /></button>
        </div>
        <p className="cd-ayuda">{conv.title || t('untitled')}</p>
        {espacios === null ? <p className="cd-ayuda">{t('loadingMore')}</p> : (
          <div className="cd-opciones cd-opciones--fijas" role="listbox" aria-label={t('spaces')}>
            {opcion(null, t('noSpace'), 'cerrar')}
            {espacios.map((e) => opcion(e.id, e.nombre, 'carpeta'))}
            {espacios.length === 0 && (
              <button type="button" className="cd-opcion" onClick={() => { onClose(); navigate('/espacios'); }}>
                <Icono nombre="mas" size={16} /><span>{t('createSpace')}</span>
              </button>
            )}
          </div>
        )}
        {error && <p className="page__error" role="alert">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="pill-btn pill-btn--outline" onClick={onClose}>{tc('cancel')}</button>
          <button type="button" className="pill-btn pill-btn--primary" onClick={guardar}
            disabled={guardando || elegido === (conv.espacio_id || null)}>{t('move')}</button>
        </div>
      </div>
    </div>
  );
}
