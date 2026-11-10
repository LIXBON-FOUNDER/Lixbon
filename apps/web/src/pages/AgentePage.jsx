// Un agente programado: su tarea, sus ejecuciones (estado con icono) y, a la
// derecha, el resumen y el resultado de la ejecución elegida. Mientras haya
// una en curso la página se refresca sola.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { Link, useNavigate } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { useShell } from '../components/AppShell';
import { useConfirmar } from '../hooks/useConfirmar';
import { Icono, IconMenu } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { Baldosa, Estado, VentanaAgente, useFechaCorta, useHorario } from '../components/Espacios';
import { borrarAgente, editarAgente, ejecutarAgente, errorDe, leerAgente, leerEjecucion } from '../lib/espacios';
import '../styles/espacios.css';

const REFRESCO = 3000;

function duracion(t, x) {
  if (!x.fin) return '';
  const s = Math.max(1, Math.round((new Date(x.fin) - new Date(x.inicio)) / 1000));
  return s < 60 ? t('seconds', { n: s }) : t('minutes', { m: Math.floor(s / 60), s: s % 60 });
}

function Bloque({ icono, titulo, items }) {
  if (!items?.length) return null;
  return (
    <section className="esp-bloque">
      <h3><Icono nombre={icono} size={16} />{titulo}</h3>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </section>
  );
}

function Resumen({ ejecucionId }) {
  const t = useT('espacios');
  const fecha = useFechaCorta();
  const [x, setX] = useState(null);
  const [copiado, setCopiado] = useState(false);
  useEffect(() => {
    let vivo = true;
    setX(null);
    leerEjecucion(ejecucionId).then((d) => vivo && setX(d)).catch(() => {});
    return () => { vivo = false; };
  }, [ejecucionId]);
  if (!x) return <p className="int-vacio">{t('loading')}</p>;
  const r = x.resumen || {};
  const copiar = async () => {
    try { await navigator.clipboard.writeText(x.resultado); setCopiado(true); setTimeout(() => setCopiado(false), 1500); } catch { /* sin permiso */ }
  };
  return (
    <div className="esp-resumen">
      <p className="esp-resumen__etq">{t('summary', { cuando: fecha(x.inicio).toLowerCase() })}</p>
      {x.estado === 'error' && (
        <section className="esp-bloque"><h3><Icono nombre="fallo" size={16} />{t('state_error')}</h3>
          <p className="esp-carta__texto" style={{ WebkitLineClamp: 'unset' }}>{x.error}</p></section>
      )}
      <Bloque icono="completado" titulo={t('did')} items={r.hizo} />
      <Bloque icono="alerta" titulo={t('keepInMind')} items={r.tener_en_cuenta} />
      <Bloque icono="siguiente" titulo={t('nextSteps')} items={r.siguientes} />
      {x.resultado && (
        <section className="esp-bloque">
          <h3><Icono nombre="texto" size={16} />{t('result')}
            <button type="button" className="icon-btn" style={{ marginLeft: 'auto' }} onClick={copiar}
              aria-label={copiado ? t('copied') : t('copy')} title={copiado ? t('copied') : t('copy')}>
              <Icono nombre={copiado ? 'hecho' : 'copiar'} size={16} />
            </button>
          </h3>
          <div className="esp-resultado"><Markdown>{x.resultado}</Markdown></div>
        </section>
      )}
    </div>
  );
}

export default function AgentePage() {
  const t = useT('espacios');
  const tch = useT('chat');
  const locale = useLocale();
  const { id } = useParams();
  const navigate = useNavigate();
  const confirmar = useConfirmar();
  const horario = useHorario();
  const fecha = useFechaCorta();
  const { openDrawer, drawerOpen } = useShell();
  const [ag, setAg] = useState(undefined);
  const [sel, setSel] = useState(null);
  const [editar, setEditar] = useState(false);
  const [error, setError] = useState('');
  const [lanzando, setLanzando] = useState(false);
  useSeo({ title: ag?.nombre || t('seoTitle'), noindex: true });

  const cargar = useCallback(() => leerAgente(id).then((d) => {
    setAg(d);
    setSel((s) => s || d.ejecuciones.find((x) => x.estado !== 'curso')?.id || null);
  }).catch(() => setAg(null)), [id]);
  useEffect(() => { cargar(); }, [cargar]);

  const trabajando = ag?.ejecuciones?.some((x) => x.estado === 'curso');
  useEffect(() => {
    if (!trabajando) return undefined;
    const h = setInterval(() => {
      leerAgente(id).then((d) => {
        setAg(d);
        // Al terminar, se abre el resumen de la que acaba de acabar.
        const ultima = d.ejecuciones[0];
        if (ultima && ultima.estado !== 'curso') setSel(ultima.id);
      }).catch(() => {});
    }, REFRESCO);
    return () => clearInterval(h);
  }, [trabajando, id]);

  const ejecutar = async () => {
    setError('');
    setLanzando(true);
    try { await ejecutarAgente(id); await cargar(); } catch (e) { setError(errorDe(e, t('loadError'))); } finally { setLanzando(false); }
  };
  const pausar = async () => { await editarAgente(id, { pausado: !ag.pausado }); cargar(); };
  const borrar = async () => {
    const ok = await confirmar({ titulo: t('deleteAgentTitle'), texto: t('deleteAgentText'), etiqueta: t('delete') });
    if (!ok) return;
    await borrarAgente(id);
    navigate(`/espacios/${ag.espacio.id}`, { replace: true });
  };

  const cabecera = (acciones) => (
    <header className="chat-header int-cab">
      <button className="icon-btn chat-header__menu" onClick={openDrawer} aria-label={tch('openConversationsPanel')}
        aria-controls="sidebar-drawer" aria-expanded={drawerOpen}><IconMenu /></button>
      <span className="esp-migas">
        <Link to="/espacios">{t('breadcrumb')}</Link>
        {ag && <><span className="esp-migas__sep">/</span><Link to={`/espacios/${ag.espacio.id}`}>{ag.espacio.nombre}</Link>
          <span className="esp-migas__sep">/</span><span>{ag.nombre}</span></>}
      </span>
      {acciones && <span className="esp-cab-acciones">{acciones}</span>}
    </header>
  );

  if (ag === undefined || ag === null) {
    return <section className="chat-main int-page">{cabecera()}<div className="int-cuerpo"><p className="int-vacio">{ag === null ? t('loadError') : t('loading')}</p></div></section>;
  }

  const proxima = ag.proxima_at && new Date(ag.proxima_at).toLocaleString(locale, { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const btn = (icono, etiqueta, onClick) => (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={etiqueta} title={etiqueta}><Icono nombre={icono} size={16} /></button>
  );

  return (
    <section className="chat-main int-page">
      {cabecera(<>
        {btn(ag.pausado ? 'reproducir' : 'pausa', ag.pausado ? t('resume') : t('pause'), pausar)}
        {btn('editar', t('editAgent'), () => setEditar(true))}
        {btn('borrar', t('deleteAgent'), borrar)}
        <button type="button" className="pill-btn pill-btn--primary" onClick={ejecutar} disabled={trabajando || lanzando}>
          <Icono nombre={trabajando ? 'en-curso' : 'rayo'} size={15} /> {trabajando ? t('running') : t('runNow')}
        </button>
      </>)}

      <div className="int-cuerpo">
        <div className="esp-agente">
          <div style={{ minWidth: 0 }}>
            <div className="esp-agente__cab">
              <Baldosa icono="agente" grande />
              <div style={{ minWidth: 0, flex: 1 }}>
                <h1>{ag.nombre}</h1>
                <p>{ag.pausado ? t('paused') : `${horario(ag)}${proxima ? ` · ${t('next', { cuando: proxima })}` : ''}`}</p>
              </div>
            </div>
            <p className="esp-tarea"><strong>{t('taskLabel')}</strong>{ag.tarea}</p>
            {error && <p className="esp-error" role="alert">{error}</p>}

            <section className="esp-seccion">
              <div className="esp-seccion__cab"><h2>{t('runs')}</h2></div>
              {!ag.ejecuciones.length && <p className="esp-vacio">{t('noRuns')}</p>}
              <div className="esp-pila">
                {ag.ejecuciones.map((x) => (
                  <button key={x.id} type="button" className={`esp-tarjeta esp-tarjeta--compacta ${sel === x.id ? 'is-sel' : ''}`}
                    onClick={() => x.estado !== 'curso' && setSel(x.id)} aria-pressed={sel === x.id}>
                    <Baldosa icono="historial" />
                    <span className="esp-tarjeta__texto">
                      <span className="esp-tarjeta__titulo">{fecha(x.inicio)}{x.origen === 'manual' ? ` · ${t('origin_manual')}` : ''}</span>
                      <span className="esp-tarjeta__sub">
                        {x.estado === 'curso' ? t('running') : x.estado === 'error' ? x.error : (x.resumen?.hizo?.[0] || '')}
                      </span>
                    </span>
                    <span className="esp-tarjeta__dato">{duracion(t, x)}</span>
                    <Estado estado={x.estado} />
                  </button>
                ))}
              </div>
            </section>
          </div>

          <aside>{sel && <Resumen key={sel} ejecucionId={sel} />}</aside>
        </div>
      </div>

      {editar && <VentanaAgente espacio={ag.espacio} agente={ag} onClose={() => setEditar(false)} onListo={cargar} />}
    </section>
  );
}
