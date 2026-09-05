import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconBag, IconCopy, IconRefresh } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Tarjeta, Vacio,
  errMsg, fmtTokens,
} from './comunes';

// El enrutado vive en el orquestador y todavía no se configura desde el panel:
// se listan como estado del sistema, no como ajustes editables.
const ENRUTADO = [
  {
    titulo: 'Balanceo por carga del nodo',
    sub: 'Elige el mejor nodo según CPU, RAM y GPU antes de cada petición.',
    activo: true,
  },
  {
    titulo: 'Circuit breaker',
    sub: 'Aísla un nodo caído con backoff exponencial y lo reintegra al recuperarse.',
    activo: true,
  },
  {
    titulo: 'Desbordar a un proveedor de reserva',
    sub: 'Requiere un back-end compatible con OpenAI. Todavía no implementado.',
    activo: false,
  },
];

function estadoClustter(nodos) {
  if (nodos.length === 0) return { tono: 'off', texto: 'Sin configurar' };
  const vivos = nodos.filter((n) => n.online).length;
  if (vivos === nodos.length) return { tono: 'ok', texto: 'Operativo' };
  if (vivos === 0) return { tono: 'bad', texto: 'Caído' };
  return { tono: 'warn', texto: 'Degradado' };
}

export default function Proveedores() {
  const [nodos, setNodos] = useState(null);
  const [modelos, setModelos] = useState([]);
  const [tokens, setTokens] = useState(null);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/nodes')
      .then((r) => setNodos(r.data.live_status))
      .catch((e) => setError(errMsg(e, 'No se pudo consultar el clúster')));
    api.get('/api/admin/models')
      .then((r) => setModelos(r.data.models))
      .catch(() => {});
    api.get('/api/admin/credits/summary')
      .then((r) => setTokens((r.data.usage_by_model || [])
        .reduce((a, x) => a + (x.tokens || 0), 0)))
      .catch(() => {});
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const endpoint = import.meta.env.VITE_API_URL || window.location.origin;
  const estado = nodos ? estadoClustter(nodos) : null;

  const copiar = () => {
    navigator.clipboard?.writeText(endpoint);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  };

  return (
    <>
      <Cabecera
        titulo="Proveedores"
        lead="De dónde salen los modelos: el clúster propio y los back-ends externos."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Probar conexiones</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!nodos ? <Cargando /> : (
          <div className="adm-rejilla-3">
            <Tarjeta>
              <div className="adm-nodo__top">
                <div className="adm-prov__cab">
                  <span className="adm-prov__icono"><IconBag size={18} /></span>
                  <div className="adm-prov__nombre">
                    <span className="adm-prov__titulo">Clúster lixbon</span>
                    <span className="adm-prov__sub">
                      Ollama en LAN · {nodos.length} {nodos.length === 1 ? 'nodo' : 'nodos'}
                    </span>
                  </div>
                </div>
                <Chip tono={estado.tono} punto>{estado.texto}</Chip>
              </div>

              <div className="adm-prov__url">
                <span>{endpoint}</span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={copiar}
                  aria-label="Copiar el endpoint"
                >
                  <IconCopy size={14} />
                </button>
              </div>
              {copiado && <span className="adm-detalle__sub">Copiado.</span>}

              <div className="adm-datos">
                <div className="adm-dato">
                  <span className="adm-dato__label">Modelos</span>
                  <span className="adm-dato__valor">{modelos.length}</span>
                </div>
                <div className="adm-dato">
                  <span className="adm-dato__label">Nodos en línea</span>
                  <span className="adm-dato__valor">
                    {nodos.filter((n) => n.online).length} / {nodos.length}
                  </span>
                </div>
                <div className="adm-dato">
                  <span className="adm-dato__label">Uso del mes</span>
                  <span className="adm-dato__valor">
                    {tokens != null ? `${fmtTokens(tokens)} tok` : '—'}
                  </span>
                </div>
              </div>
            </Tarjeta>

            <Tarjeta>
              <div className="adm-nodo__top">
                <div className="adm-prov__cab">
                  <span className="adm-prov__icono"><IconBag size={18} /></span>
                  <div className="adm-prov__nombre">
                    <span className="adm-prov__titulo">Compatible OpenAI</span>
                    <span className="adm-prov__sub">Reserva para picos de carga</span>
                  </div>
                </div>
                <Chip tono="off" punto>Sin configurar</Chip>
              </div>
              <div className="adm-prov__url"><span>sin endpoint</span></div>
              <p className="adm-card__nota">
                El gateway todavía no sabe desbordar a un proveedor externo. Cuando
                exista, se registra aquí.
              </p>
            </Tarjeta>
          </div>
        )}

        <Tarjeta titulo="Enrutado y reserva">
          <div className="adm-lista">
            {ENRUTADO.map((a) => (
              <div key={a.titulo} className="adm-ajuste">
                <div className="adm-ajuste__txt">
                  <span className="adm-ajuste__titulo">{a.titulo}</span>
                  <span className="adm-ajuste__sub">{a.sub}</span>
                </div>
                <span className={`adm-sw ${a.activo ? 'is-on' : ''}`} role="img"
                  aria-label={a.activo ? 'Activo' : 'No disponible'}>
                  <span className="adm-sw__knob" />
                </span>
              </div>
            ))}
          </div>
          <p className="adm-card__nota">
            Estos comportamientos están fijados en el orquestador; se muestran como
            estado del sistema y todavía no se cambian desde aquí.
          </p>
        </Tarjeta>

        {nodos?.length === 0 && (
          <Tarjeta>
            <Vacio>No hay nodos registrados: el clúster propio aún no sirve nada.</Vacio>
          </Tarjeta>
        )}
      </div>
    </>
  );
}
