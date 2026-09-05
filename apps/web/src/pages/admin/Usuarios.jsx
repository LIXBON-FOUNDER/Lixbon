import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../hooks/useAuth';
import { planBadge, ROLE_BADGE } from '../../lib/planColors';
import { IconChevron, IconDownload, IconSearch } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Chip, Fila, Quien, Tabla, Tarjeta, Vacio,
  errMsg, fmtDia, fmtFecha, fmtNum, nombrePlan,
} from './comunes';

const COLS = 'minmax(0,2.2fr) 110px 140px 104px 132px';

const CABECERAS = [
  { label: 'Usuario' }, { label: 'Plan' }, { label: 'Estado' },
  { label: 'Alta' }, { label: '', key: 'acciones' },
];

// Un usuario enseña un solo estado: bloqueado tapa a sin verificar, y sin
// verificar tapa a activo.
function estadoDe(u) {
  if (!u.is_active) return { tono: 'bad', texto: 'Bloqueado' };
  if (!u.email_verified) return { tono: 'warn', texto: 'Sin verificar' };
  return { tono: 'ok', texto: 'Activo' };
}

const nombreDe = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ');

function exportarCSV(users) {
  const cab = ['id', 'correo', 'nombre', 'plan', 'rol', 'activo', 'verificado', 'alta'];
  const filas = [cab.join(',')];
  for (const u of users) {
    filas.push([
      u.id, u.email || '', `"${nombreDe(u)}"`, u.plan_id, u.role,
      u.is_active ? 'sí' : 'no', u.email_verified ? 'sí' : 'no', u.created_at || '',
    ].join(','));
  }
  const blob = new Blob([filas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-usuarios-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Detalle({ u, plans, esYo, onPlan, onActivo }) {
  const [detalle, setDetalle] = useState(null);

  useEffect(() => {
    let vivo = true;
    api.get(`/api/admin/users/${u.id}`)
      .then((r) => { if (vivo) setDetalle(r.data); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [u.id]);

  const uso = detalle?.usage;

  return (
    <Tarjeta className="adm-card--detalle">
      <div className="adm-campos">
        <label className="adm-campo">
          <span className="adm-campo__label">Plan</span>
          <select
            className="adm-select"
            value={u.plan_id}
            onChange={(e) => onPlan(u.id, e.target.value)}
          >
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="adm-campo">
          <span className="adm-campo__label">Acceso</span>
          {esYo ? (
            <p className="adm-lista__label">Es tu propia cuenta: no puedes bloquearte.</p>
          ) : (
            <Boton peligro={u.is_active} onClick={() => onActivo(u)}>
              {u.is_active ? 'Bloquear cuenta' : 'Desbloquear cuenta'}
            </Boton>
          )}
        </div>
      </div>

      {!detalle ? <Cargando /> : (
        <>
          <div className="adm-lista">
            <div className="adm-lista__fila">
              <span className="adm-lista__label">Mensajes hoy</span>
              <span className="adm-lista__valor">
                {fmtNum(uso.messages_today)} / {uso.messages_per_day === -1 ? '∞' : fmtNum(uso.messages_per_day)}
              </span>
            </div>
            <div className="adm-lista__fila">
              <span className="adm-lista__label">Tokens del mes</span>
              <span className="adm-lista__valor">
                {fmtNum(uso.tokens_month)} / {uso.tokens_per_month === -1 ? '∞' : fmtNum(uso.tokens_per_month)}
              </span>
            </div>
            <div className="adm-lista__fila">
              <span className="adm-lista__label">API keys activas</span>
              <span className="adm-lista__valor">{fmtNum(detalle.active_keys)}</span>
            </div>
          </div>

          {detalle.events.length > 0 && (
            <div className="adm-bloque">
              <span className="adm-bloque__label">Últimos eventos</span>
              <div className="adm-lista">
                {detalle.events.slice(0, 5).map((e) => (
                  <div key={e.id} className="adm-lista__fila">
                    <span className="adm-lista__valor">{e.event_type}</span>
                    <span className="adm-lista__label">{fmtFecha(e.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Tarjeta>
  );
}

export default function Usuarios() {
  const { user: yo } = useAuth();
  const [users, setUsers] = useState(null);
  const [plans, setPlans] = useState([]);
  const [q, setQ] = useState('');
  const [plan, setPlan] = useState('');
  const [estado, setEstado] = useState('');
  const [abierto, setAbierto] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback((consulta) => {
    api.get('/api/admin/users', { params: consulta ? { q: consulta } : {} })
      .then((r) => setUsers(r.data.users))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar los usuarios')));
  }, []);

  useEffect(() => {
    cargar('');
    api.get('/api/admin/plans').then((r) => setPlans(r.data.plans)).catch(() => {});
  }, [cargar]);

  // El backend solo busca por texto: plan y estado se filtran en cliente.
  const visibles = useMemo(() => (users || []).filter((u) => {
    if (plan && u.plan_id !== plan) return false;
    if (estado === 'activo' && (!u.is_active || !u.email_verified)) return false;
    if (estado === 'bloqueado' && u.is_active) return false;
    if (estado === 'sin-verificar' && (u.email_verified || !u.is_active)) return false;
    return true;
  }), [users, plan, estado]);

  const cambiarPlan = async (userId, planId) => {
    setError('');
    try {
      await api.post(`/api/admin/users/${userId}/plan`, { plan_id: planId });
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, plan_id: planId } : u)));
    } catch (e) {
      setError(errMsg(e, 'No se pudo cambiar el plan'));
    }
  };

  const alternarActivo = async (u) => {
    const verbo = u.is_active ? 'bloquear' : 'desbloquear';
    if (!window.confirm(`¿Seguro que quieres ${verbo} a ${u.email || u.username}?`)) return;
    setError('');
    try {
      await api.post(`/api/admin/users/${u.id}/active`, { active: !u.is_active });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: !u.is_active } : x)));
    } catch (e) {
      setError(errMsg(e, `No se pudo ${verbo}`));
    }
  };

  const activos = (users || []).filter((u) => u.is_active).length;

  return (
    <>
      <Cabecera
        titulo="Usuarios"
        lead={users
          ? `${fmtNum(users.length)} cuentas · ${fmtNum(activos)} sin bloquear`
          : 'Cargando las cuentas…'}
      >
        <Boton disabled={!users} onClick={() => exportarCSV(users)}>
          <IconDownload size={15} /> Exportar CSV
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <form
          className="adm-filtros"
          onSubmit={(e) => { e.preventDefault(); cargar(q); }}
        >
          <div className="adm-buscar">
            <IconSearch size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por correo, nombre o usuario…"
              aria-label="Buscar usuarios"
            />
          </div>
          <select
            className="adm-btn"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            aria-label="Filtrar por plan"
          >
            <option value="">Plan: todos</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select
            className="adm-btn"
            value={estado}
            onChange={(e) => setEstado(e.target.value)}
            aria-label="Filtrar por estado"
          >
            <option value="">Estado: todos</option>
            <option value="activo">Activos</option>
            <option value="sin-verificar">Sin verificar</option>
            <option value="bloqueado">Bloqueados</option>
          </select>
          <Boton type="submit" variante="primary">Buscar</Boton>
        </form>

        <div className="adm-card adm-card--tabla">
          {!users ? <Cargando /> : visibles.length === 0 ? (
            <Vacio>Ninguna cuenta coincide con el filtro.</Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS} ancho={760}>
              {visibles.map((u) => {
                const e = estadoDe(u);
                const esAdmin = u.role === 'admin';
                return (
                  <div key={u.id}>
                    <Fila cols={COLS}>
                      <Celda><Quien nombre={nombreDe(u)} correo={u.email || u.username} /></Celda>
                      <Celda>
                        {esAdmin ? (
                          <span className="adm-chip" style={{ background: ROLE_BADGE.bg, color: ROLE_BADGE.ink }}>
                            Administrador
                          </span>
                        ) : (
                          <span
                            className="adm-chip"
                            style={{ background: planBadge(u.plan_id).bg, color: planBadge(u.plan_id).ink }}
                          >
                            {nombrePlan(u.plan_id)}
                          </span>
                        )}
                      </Celda>
                      <Celda><Chip tono={e.tono} punto>{e.texto}</Chip></Celda>
                      <Celda>
                        <span className="adm-lista__label">{fmtDia(u.created_at)}</span>
                      </Celda>
                      <Celda acciones>
                        <Boton
                          sm
                          aria-expanded={abierto === u.id}
                          onClick={() => setAbierto(abierto === u.id ? null : u.id)}
                        >
                          <IconChevron size={13} open={abierto === u.id} />
                          {abierto === u.id ? 'Cerrar' : 'Detalle'}
                        </Boton>
                      </Celda>
                    </Fila>
                    {abierto === u.id && (
                      <Detalle
                        u={u}
                        plans={plans}
                        esYo={yo?.id === u.id}
                        onPlan={cambiarPlan}
                        onActivo={alternarActivo}
                      />
                    )}
                  </div>
                );
              })}
            </Tabla>
          )}
        </div>
      </div>
    </>
  );
}
