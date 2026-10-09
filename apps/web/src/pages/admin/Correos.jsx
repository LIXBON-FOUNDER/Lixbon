import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useConfirmar } from '../../hooks/useConfirmar';
import { IconPlus, IconSend, IconTrash } from '../../components/Icons';
import { Aviso, Boton, Cabecera, Chip, Tarjeta, errMsg, fmtNum } from './comunes';

const MAX_CAMBIOS = 8;
const VACIO = { seccion: '', resumen: '' };

export default function Correos() {
  const confirmar = useConfirmar();
  const [vigencia, setVigencia] = useState('');
  const [cambios, setCambios] = useState([{ ...VACIO }]);
  const [anterior, setAnterior] = useState('');
  const [prueba, setPrueba] = useState('');
  const [estado, setEstado] = useState(null);
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const r = await api.get('/api/admin/terms-notice', { params: vigencia ? { vigencia } : {} });
      setEstado(r.data);
    } catch (e) {
      setError(errMsg(e, 'No se pudo leer el estado del envío'));
    }
  }, [vigencia]);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => {
    if (!estado?.envio?.activo) return undefined;
    const t = setInterval(cargar, 1500);
    return () => clearInterval(t);
  }, [estado?.envio?.activo, cargar]);

  const validos = cambios.filter((c) => c.seccion.trim() && c.resumen.trim());
  const listo = vigencia && validos.length > 0 && validos.length === cambios.length;
  const cuerpo = () => ({ vigencia, cambios: validos, url_anterior: anterior.trim() || null });

  const enviarPrueba = async () => {
    setError(''); setOk(''); setEnviando(true);
    try {
      await api.post('/api/admin/terms-notice', { ...cuerpo(), prueba: prueba.trim() });
      setOk(`Prueba enviada a ${prueba.trim()}.`);
    } catch (e) {
      setError(errMsg(e, 'No se pudo enviar la prueba'));
    } finally {
      setEnviando(false);
    }
  };

  const enviarTodos = async () => {
    const n = estado?.pendientes;
    const si = await confirmar({
      titulo: `¿Avisar a ${n == null ? 'todas las cuentas' : `${fmtNum(n)} cuentas`}?`,
      texto: 'Se envía a cada cuenta activa con el correo verificado que aún no recibió el aviso de esta vigencia. Repetirlo no duplica correos.',
      etiqueta: 'Enviar',
    });
    if (!si) return;
    setError(''); setOk(''); setEnviando(true);
    try {
      const r = await api.post('/api/admin/terms-notice', cuerpo());
      setOk(r.data.destinatarios
        ? `Enviando a ${fmtNum(r.data.destinatarios)} cuentas.`
        : 'No queda nadie por avisar para esta vigencia.');
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo iniciar el envío'));
    } finally {
      setEnviando(false);
    }
  };

  const cambiar = (i, campo, valor) => setCambios(cambios.map((c, j) => (j === i ? { ...c, [campo]: valor } : c)));
  const envio = estado?.envio;

  return (
    <>
      <Cabecera
        titulo="Correos"
        lead="Avisos que se envían a mano. Los de bienvenida, acceso, contraseña y facturación salen solos."
      />

      <div className="adm__body">
        <Aviso error>{error}</Aviso>
        <Aviso>{ok}</Aviso>

        <Tarjeta
          titulo="Actualización de términos y condiciones"
          extra={envio?.activo
            ? <Chip tono="warn" punto>Enviando {fmtNum(envio.enviados)} / {fmtNum(envio.total)}</Chip>
            : vigencia && estado?.avisados != null && (
              <Chip tono={estado.pendientes ? 'warn' : 'ok'} punto>
                {fmtNum(estado.avisados)} avisadas · {fmtNum(estado.pendientes)} pendientes
              </Chip>
            )}
        >
          <div className="adm-campos">
            <label className="adm-campo">
              <span className="adm-campo__label">Entra en vigor el</span>
              <input type="date" className="adm-input" value={vigencia} onChange={(e) => setVigencia(e.target.value)} />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">Enlace a la versión anterior (opcional)</span>
              <input className="adm-input" placeholder="https://lixbon.com/…" value={anterior}
                onChange={(e) => setAnterior(e.target.value)} />
            </label>
          </div>

          <p className="adm-campo__label" style={{ margin: '18px 0 8px' }}>Qué cambia, en lenguaje claro</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {cambios.map((c, i) => (
              <div key={i} className="adm-campos" style={{ gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 2fr) auto', alignItems: 'start' }}>
                <input className="adm-input" placeholder="Sección (p. ej. Planes y pagos)" value={c.seccion}
                  maxLength={120} aria-label={`Sección del cambio ${i + 1}`}
                  onChange={(e) => cambiar(i, 'seccion', e.target.value)} />
                <textarea className="adm-input adm-input--area" placeholder="Resumen del cambio en una frase" value={c.resumen}
                  maxLength={400} rows={2} aria-label={`Resumen del cambio ${i + 1}`}
                  onChange={(e) => cambiar(i, 'resumen', e.target.value)} />
                <Boton sm peligro aria-label={`Quitar el cambio ${i + 1}`} disabled={cambios.length === 1}
                  onClick={() => setCambios(cambios.filter((_, j) => j !== i))}>
                  <IconTrash size={14} />
                </Boton>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Boton sm disabled={cambios.length >= MAX_CAMBIOS} onClick={() => setCambios([...cambios, { ...VACIO }])}>
              <IconPlus size={14} /> Añadir cambio
            </Boton>
          </div>

          <div className="adm-card__pie" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flex: '1 1 280px' }}>
              <input className="adm-input" type="email" placeholder="tu@correo.com" value={prueba}
                aria-label="Correo para la prueba" onChange={(e) => setPrueba(e.target.value)} />
              <Boton disabled={!listo || !prueba.includes('@') || enviando} onClick={enviarPrueba}>
                Enviar prueba
              </Boton>
            </div>
            <Boton variante="primary" disabled={!listo || enviando || envio?.activo} onClick={enviarTodos}>
              <IconSend size={15} /> Enviar a todas las cuentas
            </Boton>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Antes de enviar">
          <p className="adm-card__nota">
            Publica primero el texto nuevo en <span className="mono">/legal/terms</span> y su fecha de vigencia: el
            correo enlaza ahí. Manda una prueba a tu buzón para revisar cómo se ve. El envío masivo recuerda a quién
            ya avisó para cada fecha, así que si se corta puedes volver a pulsarlo sin repetir correos.
          </p>
        </Tarjeta>
      </div>
    </>
  );
}
