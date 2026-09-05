import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { IconDownload, IconSearch } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Fila, Tabla, Vacio,
  errMsg, fmtFecha,
} from './comunes';

const PAGINA = 50;
const COLS = '156px minmax(0,1fr) 200px 132px minmax(0,1.1fr)';

const CABECERAS = [
  { label: 'Fecha' }, { label: 'Evento' }, { label: 'Usuario' },
  { label: 'IP' }, { label: 'Detalle' },
];

// El backend no clasifica los eventos, así que la severidad se deriva del
// nombre: lo que toca dinero, accesos o el clúster no puede leerse igual que
// un inicio de sesión. Al añadir un evento nuevo, decide aquí dónde cae.
const CRITICO = /(_failed|_denied|_revoked|circuit_open|_deleted)/;
const ATENCION = /^(admin_|credits_|plan_|release_|node_)|(_blocked|_reset)/;

function severidadDe(tipo) {
  if (CRITICO.test(tipo)) return { nivel: 'critico', color: 'var(--danger)' };
  if (ATENCION.test(tipo)) return { nivel: 'atencion', color: 'var(--warn)' };
  return { nivel: 'rutina', color: 'var(--ok)' };
}

const LEYENDA = [
  { nivel: 'rutina', label: 'Rutina', color: 'var(--ok)' },
  { nivel: 'atencion', label: 'Atención', color: 'var(--warn)' },
  { nivel: 'critico', label: 'Crítico', color: 'var(--danger)' },
];

const detalleDe = (meta) => {
  const claves = Object.keys(meta || {});
  if (claves.length === 0) return '—';
  return claves.map((k) => `${k}=${meta[k]}`).join(' · ');
};

function exportarCSV(eventos) {
  const filas = [['fecha', 'evento', 'severidad', 'usuario', 'ip', 'detalle'].join(',')];
  for (const e of eventos) {
    filas.push([
      e.created_at, e.event_type, severidadDe(e.event_type).nivel,
      e.user_id ?? '', e.ip_address || '', `"${detalleDe(e.metadata)}"`,
    ].join(','));
  }
  const blob = new Blob([filas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Auditoria() {
  const [eventos, setEventos] = useState(null);
  const [tipo, setTipo] = useState('');
  const [nivel, setNivel] = useState('');
  const [fin, setFin] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback((offset, filtro, reemplaza) => {
    api.get('/api/admin/audit', {
      params: { limit: PAGINA, offset, ...(filtro ? { event_type: filtro } : {}) },
    })
      .then((r) => {
        setEventos((prev) => (reemplaza ? r.data.events : [...(prev || []), ...r.data.events]));
        setFin(r.data.events.length < PAGINA);
      })
      .catch((e) => setError(errMsg(e, 'No se pudo cargar la auditoría')));
  }, []);

  useEffect(() => { cargar(0, '', true); }, [cargar]);

  const visibles = useMemo(
    () => (eventos || []).filter((e) => !nivel || severidadDe(e.event_type).nivel === nivel),
    [eventos, nivel],
  );

  return (
    <>
      <Cabecera
        titulo="Auditoría"
        lead="Cada acción sensible queda registrada con su origen. Solo lectura."
      >
        <Boton disabled={!eventos} onClick={() => exportarCSV(eventos)}>
          <IconDownload size={15} /> Exportar
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <form
          className="adm-filtros"
          onSubmit={(e) => { e.preventDefault(); cargar(0, tipo, true); }}
        >
          <div className="adm-buscar">
            <IconSearch size={16} />
            <input
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
              placeholder="Filtrar por tipo de evento (ej: user_login)…"
              aria-label="Filtrar por tipo de evento"
            />
          </div>
          <select
            className="adm-btn"
            value={nivel}
            onChange={(e) => setNivel(e.target.value)}
            aria-label="Filtrar por severidad"
          >
            <option value="">Severidad: todas</option>
            {LEYENDA.map((l) => (
              <option key={l.nivel} value={l.nivel}>{l.label}</option>
            ))}
          </select>
          <Boton type="submit" variante="primary">Filtrar</Boton>
        </form>

        <div className="adm-leyenda">
          {LEYENDA.map((l) => (
            <span key={l.nivel} className="adm-leyenda__item">
              <span
                className="adm-leyenda__muestra"
                style={{ background: l.color, borderRadius: '999px' }}
              />
              {l.label}
            </span>
          ))}
          <span className="adm-pie__cuenta" style={{ marginLeft: 'auto' }}>
            {eventos ? `${visibles.length} eventos listados` : ''}
          </span>
        </div>

        <div className="adm-card adm-card--tabla">
          {!eventos ? <Cargando /> : visibles.length === 0 ? (
            <Vacio>Ningún evento coincide con el filtro.</Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS} ancho={940}>
              {visibles.map((e) => {
                const s = severidadDe(e.event_type);
                return (
                  <Fila key={e.id} cols={COLS}>
                    <Celda>
                      <span className="adm-lista__label">{fmtFecha(e.created_at)}</span>
                    </Celda>
                    <Celda>
                      <span className="adm-evento">
                        <span className="adm-evento__punto" style={{ background: s.color }} />
                        <span className="mono">{e.event_type}</span>
                      </span>
                    </Celda>
                    <Celda>{e.user_id ?? '—'}</Celda>
                    <Celda><span className="mono adm-lista__label">{e.ip_address || '—'}</span></Celda>
                    <Celda>
                      <span className="mono adm-lista__label">{detalleDe(e.metadata)}</span>
                    </Celda>
                  </Fila>
                );
              })}
            </Tabla>
          )}
        </div>

        {!fin && eventos?.length > 0 && (
          <div className="adm-mas">
            <Boton onClick={() => cargar(eventos.length, tipo, false)}>Cargar más</Boton>
          </div>
        )}
      </div>
    </>
  );
}
