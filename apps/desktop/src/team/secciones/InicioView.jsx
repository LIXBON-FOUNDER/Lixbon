// InicioView.jsx — lo primero que ves: tus issues, el ciclo, lo que te piden en
// el chat, qué agentes están trabajando y lo último que ha pasado en el equipo.
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { useTablero } from '../store/useTablero';
import { TPanel, Cara, nombreDe } from '../ui/Panel';
import { Rombos, Casilla, Agente } from '../ui/Marcas';
import { IconAgente, IconHash, IconBurbuja } from '../ui/icons';
import { IconPlus } from '../../components/Icons';
import { esCerrado, vencimiento, avance, diasEntre, hoyISO, haceRato, DIAS, MESES_LARGOS, diaDe } from '../lib/issues';

function saludo() {
  const h = new Date().getHours();
  if (h < 13) return 'Buenos días';
  if (h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

export function InicioView() {
  const { usuario, irA, volverAlChat, noLeidos, proyectos, abrirCanal } = useTeamStore();
  const abrir = useIssuesStore((s) => s.abrir);
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  const t = useTablero();
  const hoy = hoyISO();
  const d = diaDe(hoy);

  const abiertas = t.issues.filter((i) => !esCerrado(t.estadosPorId[i.estado_id]));
  const mias = abiertas.filter((i) => i.asignado_id === usuario?.id)
    .sort((a, b) => (b.prioridad - a.prioridad) || String(a.fecha_limite || '9999').localeCompare(String(b.fecha_limite || '9999')));
  const conAgente = abiertas.filter((i) => i.agente_rol);
  const delCiclo = t.cicloHoy ? t.issues.filter((i) => i.ciclo_id === t.cicloHoy.id) : [];
  const av = avance(delCiclo, t.estadosPorId);
  const enLinea = t.miembros.filter((m) => m.estado === 'en_linea').length;
  const vencenHoy = abiertas.filter((i) => i.fecha_limite === hoy);
  const recientes = [...t.issues].sort((a, b) => b.actualizado_en.localeCompare(a.actualizado_en)).slice(0, 6);

  const conversaciones = proyectos.flatMap((p) => p.canales.map((c) => ({ c, p })))
    .filter(({ c }) => noLeidos[c.id]).slice(0, 5);

  const tramo = (tipo) => (av.total ? ((av.porTipo[tipo] || 0) / av.total) * 100 : 0);
  const quedan = t.cicloHoy ? diasEntre(hoy, t.cicloHoy.termina) : null;

  return (
    <TPanel id="inicio" className="wb__grow tinicio">
      <div className="tinicio__cab">
        <div>
          <h1>{saludo()}, {nombreDe(usuario)}</h1>
          <p>
            {DIAS[(d.getDay() + 6) % 7][0].toUpperCase()}{DIAS[(d.getDay() + 6) % 7].slice(1)} {d.getDate()} de {MESES_LARGOS[d.getMonth()]}
            {t.cicloHoy && ` · ciclo ${t.cicloHoy.numero}, día ${diasEntre(t.cicloHoy.empieza, hoy) + 1} de ${diasEntre(t.cicloHoy.empieza, t.cicloHoy.termina) + 1}`}
            {` · ${enLinea} ${enLinea === 1 ? 'persona' : 'personas'} en línea`}
          </p>
        </div>
        <span className="tfill" />
        <button className="btn btn--ghost" onClick={volverAlChat}><IconBurbuja size={14} /> Ir al chat</button>
        {t.proyecto && <button className="btn btn--acento" onClick={() => abrirCreacion({ proyectoId: t.proyectoId })}><IconPlus size={14} /> Nueva issue <kbd>C</kbd></button>}
      </div>

      <div className="tinicio__rejilla">
        <div className="tinicio__col">
          <section className="tbloquei">
            <div className="tbloquei__cab">
              <h2>Para ti</h2><span className="tdim">{mias.length} {mias.length === 1 ? 'abierta' : 'abiertas'}</span>
              <span className="tfill" /><button className="tlink" onClick={() => irA('issues')}>Ver issues</button>
            </div>
            {mias.slice(0, 7).map((i) => {
              const v = vencimiento(i.fecha_limite);
              return (
                <button key={i.id} className="tmia" onClick={() => abrir(i.id)}>
                  <span className="tmia__prio">{i.prioridad > 0 && <Rombos prioridad={i.prioridad} />}</span>
                  <Casilla estado={t.estadosPorId[i.estado_id]} size={15} />
                  <span className="mono tdim">{i.clave}</span>
                  <span className="tmia__t">{i.titulo}</span>
                  {v && <span className={`tvence is-${v.tono}`}>{v.texto}</span>}
                </button>
              );
            })}
            {!mias.length && <p className="tnota">Nada asignado a ti. Buen momento para mirar el backlog.</p>}
          </section>

          <section className="tbloquei tbloquei--crece">
            <div className="tbloquei__cab"><h2>Agentes trabajando</h2><span className="tdim">desde el orquestador del IDE</span></div>
            {conAgente.slice(0, 4).map((i) => (
              <button key={i.id} className="tagenteact" onClick={() => abrir(i.id)}>
                <span className="tagente__ico is-grande"><IconAgente size={16} /></span>
                <span className="tagenteact__txt">
                  <Agente rol={i.agente_rol} />
                  <span><span className="mono">{i.clave}</span> · {i.titulo}</span>
                </span>
                <span className="tagenteact__estado"><Casilla estado={t.estadosPorId[i.estado_id]} size={14} />{t.estadosPorId[i.estado_id]?.nombre}</span>
              </button>
            ))}
            {!conAgente.length && <p className="tnota">Ninguna issue delegada. Desde el detalle de una issue, «Delegar al orquestador» se la pasa a un agente del IDE.</p>}
          </section>
        </div>

        <div className="tinicio__col">
          {t.cicloHoy ? (
            <button className="tbloquei tciclomini" onClick={() => irA('proyectos')}>
              <div className="tbloquei__cab"><h2>Ciclo {t.cicloHoy.numero}</h2><span className="tdim">{quedan === 0 ? 'cierra hoy' : `cierra en ${quedan} ${quedan === 1 ? 'día' : 'días'}`}</span></div>
              <div className="tciclomini__num"><b>{av.cerradas}</b><span>de {av.total} issues cerradas</span></div>
              <div className="tpila" aria-hidden="true">
                <span style={{ width: `${tramo('hecho') + tramo('cancelado')}%`, background: 'var(--good)' }} />
                <span style={{ width: `${tramo('revision')}%`, background: 'var(--warn)' }} />
                <span style={{ width: `${tramo('en_curso')}%`, background: 'var(--info)' }} />
                <span style={{ width: `${tramo('pendiente') + tramo('backlog')}%`, background: 'var(--surface-6)' }} />
              </div>
              <div className="tleyenda">
                <span><i style={{ background: 'var(--good)' }} />Hecho {(av.porTipo.hecho || 0) + (av.porTipo.cancelado || 0)}</span>
                <span><i style={{ background: 'var(--warn)' }} />Revisión {av.porTipo.revision || 0}</span>
                <span><i style={{ background: 'var(--info)' }} />En curso {av.porTipo.en_curso || 0}</span>
                <span><i style={{ background: 'var(--surface-6)' }} />Por hacer {(av.porTipo.pendiente || 0) + (av.porTipo.backlog || 0)}</span>
              </div>
            </button>
          ) : (
            <section className="tbloquei">
              <div className="tbloquei__cab"><h2>Sin ciclos</h2></div>
              <p className="tnota">Con ciclos, el trabajo se organiza en tramos de una a cuatro semanas y lo pendiente pasa solo al siguiente.</p>
              {t.lider && <button className="btn btn--sm" onClick={() => irA('proyecto')}>Activar en Ajustes del equipo</button>}
            </section>
          )}

          <section className="tbloquei tbloquei--crece">
            <div className="tbloquei__cab"><h2>Sin leer</h2></div>
            {conversaciones.map(({ c, p }) => (
              <button key={c.id} className="tmia" onClick={() => abrirCanal(c.id)}>
                <IconHash size={14} /><span className="tmia__t">{c.nombre}</span><span className="tdim">{p.nombre}</span>
                <span className="tcarril__num">{noLeidos[c.id]}</span>
              </button>
            ))}
            {!conversaciones.length && <p className="tnota">Estás al día en el chat.</p>}
          </section>
        </div>

        <div className="tinicio__col">
          <section className="tbloquei">
            <div className="tbloquei__cab"><h2>Hoy</h2><span className="tfill" /><button className="tlink" onClick={() => irA('calendario')}>Calendario</button></div>
            {vencenHoy.map((i) => (
              <button key={i.id} className="tmia" onClick={() => abrir(i.id)}>
                <Casilla estado={t.estadosPorId[i.estado_id]} size={15} /><span className="mono tdim">{i.clave}</span><span className="tmia__t">vence hoy · {i.titulo}</span>
              </button>
            ))}
            {t.cicloHoy?.termina === hoy && <p className="tnota">Hoy cierra el ciclo {t.cicloHoy.numero}.</p>}
            {!vencenHoy.length && t.cicloHoy?.termina !== hoy && <p className="tnota">Nada vence hoy.</p>}
          </section>

          <section className="tbloquei tbloquei--crece">
            <div className="tbloquei__cab"><h2>Movido hace poco</h2></div>
            {recientes.map((i) => {
              const m = t.gente[i.asignado_id];
              return (
                <button key={i.id} className="tmia" onClick={() => abrir(i.id)}>
                  <Casilla estado={t.estadosPorId[i.estado_id]} size={15} />
                  <span className="mono tdim">{i.clave}</span>
                  <span className="tmia__t">{i.titulo}</span>
                  {m && <Cara usuario={m.usuario} size={18} />}
                  <span className="tdim tmia__cuando">{haceRato(i.actualizado_en)}</span>
                </button>
              );
            })}
            {!recientes.length && <p className="tnota">Todavía no hay movimiento.</p>}
          </section>
        </div>
      </div>
    </TPanel>
  );
}
