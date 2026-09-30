// AjustesView.jsx — ajustes del equipo (general, miembros, issues, canales) y
// de esta ventana (tamaño de la interfaz, conversaciones acopladas al IDE).
import { useEffect, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import * as api from '../lib/api';
import { useAcopladosStore } from '../store/acopladosStore';
import { normalizeRepo } from '../lib/githubApi';
import { estadoDef } from '../lib/presencia';
import { TPanel, Cara, nombreDe } from '../ui/Panel';
import { inicialesDe } from '../layout/TeamTitleBar';
import { IconTrash, IconPlus, IconX, IconCheck } from '../../components/Icons';
import { IconGitHub, IconHash, IconLock } from '../ui/icons';
import { AjustesIssues } from './issues/AjustesIssues';
import { UI_SCALES, readUiScale, setUiScale } from '../../lib/uiScale';


function pistaRepo(valor) {
  const limpio = String(valor || '').trim();
  if (!limpio) return 'Vale «owner/repo» o la dirección completa: se recorta sola.';
  const normal = normalizeRepo(limpio);
  if (!normal) return 'No se reconoce. Ejemplo: vercel/next.js';
  return normal === limpio ? 'Con esto, Repositorio ya puede leerlo.' : `Se guardará como «${normal}».`;
}

function General({ proyecto, lider }) {
  const editarProyecto = useTeamStore((s) => s.editarProyecto);
  const [nombre, setNombre] = useState(proyecto.nombre);
  const [repo, setRepo] = useState(proyecto.github_repo || '');
  const [guardado, setGuardado] = useState('');
  useEffect(() => {
    setNombre(proyecto.nombre);
    setRepo(proyecto.github_repo || '');
    setGuardado('');
  }, [proyecto.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const guardar = async (e) => {
    e.preventDefault();
    const normal = normalizeRepo(repo.trim());
    if (repo.trim() && !normal) { setGuardado('Ese repositorio no se entiende. Pon «owner/repo».'); return; }
    const fallo = await editarProyecto(proyecto.id, {
      nombre: nombre.trim() || proyecto.nombre,
      github_repo: normal || null,
    });
    if (!fallo) setRepo(normal);
    setGuardado(fallo || 'Guardado.');
  };

  return (
    <form className="tajustes__sec" onSubmit={guardar}>
      <div className="tajustes__cab">
        <h1>General</h1>
        <p>{lider ? `Lo ven los ${proyecto.miembros.length} integrantes de ${proyecto.nombre}.` : 'Formas parte de este equipo. Los ajustes los lleva su líder.'}</p>
      </div>
      <div className="tajustes__fila">
        <span className="tproy tproy--xl">{proyecto.tablero?.prefijo || inicialesDe(nombre)}</span>
        <label className="tcampo tfill">Nombre del equipo
          <input className="tinput" value={nombre} onChange={(e) => setNombre(e.target.value)} disabled={!lider} maxLength={60} />
        </label>
      </div>
      <span className="tajustes__h2">Repositorio</span>
      <div className="tcaja">
        <IconGitHub size={18} />
        <label className="tcampo tfill">Repositorio de GitHub
          <input className="tinput mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" spellCheck={false} disabled={!lider} />
          <span className="tnota">{pistaRepo(repo)}</span>
        </label>
        <span className={`tvinculo ${proyecto.github_repo ? 'is-on' : ''}`}><span className="tpunto" />{proyecto.github_repo ? 'Vinculado' : 'Sin vincular'}</span>
      </div>
      <p className="tnota">El equipo guarda a qué repositorio apunta, nunca una credencial: cada integrante lo lee con su propia clave de GitHub.</p>
      {lider && proyecto.github_repo && <WebhookGithub proyecto={proyecto} />}
      {lider && (
        <div className="tajustes__acc">
          <button className="btn btn--primary" type="submit">Guardar</button>
          {guardado && <span className={guardado === 'Guardado.' ? 'tok' : 'terror'}>{guardado}</span>}
        </div>
      )}
    </form>
  );
}

function Copiable({ etiqueta, valor, secreto = false }) {
  const [visto, setVisto] = useState(!secreto);
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try { await navigator.clipboard.writeText(valor); setCopiado(true); setTimeout(() => setCopiado(false), 1500); } catch { /* sin portapapeles */ }
  };
  return (
    <div className="tcopiable">
      <span className="tcopiable__e">{etiqueta}</span>
      <code className="tcopiable__v mono">{visto ? valor : '•'.repeat(24)}</code>
      {secreto && <button type="button" className="lk" onClick={() => setVisto((v) => !v)}>{visto ? 'Ocultar' : 'Ver'}</button>}
      <button type="button" className="lk" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar'}</button>
    </div>
  );
}

/** Lo que el líder pega en GitHub para que ramas, commits y PR muevan las
 *  issues solos. El secreto firma cada aviso; rotarlo invalida el anterior. */
function WebhookGithub({ proyecto }) {
  const [w, setW] = useState(null);
  const [error, setError] = useState('');
  const [rotando, setRotando] = useState(false);
  useEffect(() => {
    let vivo = true;
    api.webhookGithub(proyecto.id).then((d) => vivo && setW(d)).catch((e) => vivo && setError(e.message));
    return () => { vivo = false; };
  }, [proyecto.id]);
  const rotar = async () => {
    setRotando(true);
    try { setW(await api.rotarWebhookGithub(proyecto.id)); } catch (e) { setError(e.message); }
    setRotando(false);
  };
  return (
    <div className="twebhook">
      <span className="tajustes__h2">Webhook de GitHub</span>
      <p className="tnota">
        En GitHub, abre <span className="mono">{proyecto.github_repo}</span> › Settings › Webhooks › Add webhook y pega esto.
        Con él, una rama <span className="mono">lx/{(proyecto.tablero?.prefijo || 'lxb').toLowerCase()}-12-…</span>, un commit o un PR que citen
        la clave se vinculan a la issue y la mueven según los automatismos del equipo.
      </p>
      {error && <p className="terror">{error}</p>}
      {w && (
        <div className="tcopiables">
          <Copiable etiqueta="Payload URL" valor={w.url} />
          <Copiable etiqueta="Content type" valor={w.tipo} />
          <Copiable etiqueta="Secret" valor={w.secreto} secreto />
          <div className="tcopiable">
            <span className="tcopiable__e">Eventos</span>
            <span className="tcopiable__v">Pull requests, Branch or tag creation y Pushes</span>
          </div>
        </div>
      )}
      {w && <button type="button" className="btn btn--ghost btn--sm twebhook__rotar" onClick={rotar} disabled={rotando}>{rotando ? 'Rotando…' : 'Rotar el secreto'}</button>}
    </div>
  );
}

function Gente({ proyecto, lider }) {
  const { usuario, invitar, quitarMiembro } = useTeamStore();
  const [quien, setQuien] = useState('');
  const [msg, setMsg] = useState('');
  const mandar = async (e) => {
    e.preventDefault();
    if (!quien.trim()) return;
    const fallo = await invitar(proyecto.id, quien.trim());
    setMsg(fallo || `${quien.trim()} ya está en el proyecto.`);
    if (!fallo) setQuien('');
  };
  return (
    <div className="tajustes__sec">
      <div className="tajustes__cab"><h1>Miembros y roles</h1><p>{proyecto.miembros.length} personas. El líder invita, crea canales privados y decide quién los ve.</p></div>
      {lider && (
        <form className="tajustes__fila" onSubmit={mandar}>
          <input className="tinput tfill" value={quien} onChange={(e) => setQuien(e.target.value)} placeholder="correo o @usuario" spellCheck={false} aria-label="Invitar" />
          <button className="btn btn--primary" type="submit" disabled={!quien.trim()}><IconPlus size={13} /> Invitar</button>
        </form>
      )}
      {msg && <p className="tnota">{msg}</p>}
      <div className="tajustes__lista">
        {proyecto.miembros.map((m) => {
          const def = estadoDef(m.estado);
          return (
            <div key={m.usuario.id} className="tajustes__item">
              <Cara usuario={m.usuario} estado={m.estado} size={28} />
              <span className="tgente__n tfill"><span>{nombreDe(m.usuario)}{m.usuario.id === usuario?.id ? ' (tú)' : ''}</span><span className="tdim">{m.rol === 'lider' ? 'Líder' : 'Integrante'} · {def.label}</span></span>
              {lider && m.rol !== 'lider' && <button className="ic tmsg__malo" onClick={() => quitarMiembro(proyecto.id, m.usuario.id)} aria-label="Quitar del proyecto"><IconTrash size={14} /></button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Canales({ proyecto, lider }) {
  const { borrarCanal, sumarACanal, sacarDeCanal } = useTeamStore();
  const [abierto, setAbierto] = useState(null);
  const [borrando, setBorrando] = useState(null);
  return (
    <div className="tajustes__sec">
      <div className="tajustes__cab"><h1>Canales</h1><p>Los públicos los ve todo el proyecto; los privados, solo quien el líder elija.</p></div>
      <div className="tajustes__lista">
        {proyecto.canales.map((c) => (
          <div key={c.id}>
            <div className="tajustes__item">
              {c.tipo === 'privado' ? <IconLock size={14} className="tdim" /> : <IconHash size={14} className="tdim" />}
              <span className="tgente__n tfill"><span>{c.nombre}</span><span className="tdim">{c.tipo === 'privado' ? 'Privado' : 'Todo el proyecto'}{c.tema ? ` · ${c.tema}` : ''}</span></span>
              {lider && c.tipo === 'privado' && <button className="lk" onClick={() => setAbierto(abierto === c.id ? null : c.id)}>{abierto === c.id ? 'Cerrar' : 'Quién lo ve'}</button>}
              {lider && (borrando === c.id
                ? <><button className="btn btn--sm tmsg__borrar" onClick={() => { borrarCanal(c.id); setBorrando(null); }}>Borrar canal</button><button className="ic" onClick={() => setBorrando(null)} aria-label="Cancelar"><IconX size={13} /></button></>
                : <button className="ic tmsg__malo" onClick={() => setBorrando(c.id)} aria-label="Borrar el canal y sus mensajes"><IconTrash size={14} /></button>)}
            </div>
            {abierto === c.id && (
              <div className="tajustes__sub">
                {proyecto.miembros.map((m) => (
                  <div key={m.usuario.id} className="tajustes__item">
                    <Cara usuario={m.usuario} size={22} />
                    <span className="tfill">{nombreDe(m.usuario)}</span>
                    <button className="btn btn--ghost btn--sm" onClick={() => sumarACanal(c.id, m.usuario.id)}><IconCheck size={12} /> Dar acceso</button>
                    <button className="ic tmsg__malo" onClick={() => sacarDeCanal(c.id, m.usuario.id)} aria-label="Quitar el acceso"><IconTrash size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Interfaz() {
  const [zoom, setZoom] = useState(readUiScale);
  useEffect(() => {
    const alCambiar = (e) => setZoom(e.detail);
    window.addEventListener('lixbon:ui-scale', alCambiar);
    return () => window.removeEventListener('lixbon:ui-scale', alCambiar);
  }, []);
  const { ids, alternar } = useAcopladosStore();
  const directos = useTeamStore((s) => s.directos);
  const proyectos = useTeamStore((s) => s.proyectos);
  const nombreCanal = (id) => {
    for (const p of proyectos) { const c = p.canales.find((x) => x.id === id); if (c) return `#${c.nombre} · ${p.nombre}`; }
    const d = directos.find((x) => x.id === id);
    return d ? nombreDe(d.con) : null;
  };
  const idx = Math.max(0, UI_SCALES.indexOf(zoom));
  return (
    <div className="tajustes__sec">
      <div className="tajustes__cab"><h1>Interfaz</h1><p>Es el mismo ajuste que el del IDE: cambia las dos ventanas. También con Ctrl + y Ctrl −.</p></div>
      <span className="tajustes__h2">Tamaño de la interfaz</span>
      <div className="seg seg--md tajustes__seg">
        <span className="seg__thumb" style={{ width: 72, transform: `translateX(${idx * 72}px)` }} />
        {UI_SCALES.map((z) => <button key={z} className={`seg__opt mono ${z === zoom ? 'is-active' : ''}`} style={{ width: 72 }} onClick={() => setUiScale(z)}>{Math.round(z * 100)} %</button>)}
      </div>
      <span className="tajustes__h2">Acoplados al IDE</span>
      <p className="tnota">Estas conversaciones aparecen en el panel derecho del IDE, junto al editor.</p>
      <div className="tajustes__lista">
        {(ids || []).map((id) => nombreCanal(id) && (
          <div key={id} className="tajustes__item">
            <span className="tfill">{nombreCanal(id)}</span>
            <button className="lk" onClick={() => alternar(id)}>Quitar</button>
          </div>
        ))}
        {!(ids || []).some(nombreCanal) && <p className="tnota">Ninguna todavía. Acopla una desde la cabecera de cualquier conversación.</p>}
      </div>
    </div>
  );
}

export function AjustesView() {
  const { proyectoActivo, soyLider } = useTeamStore();
  const proyecto = proyectoActivo();
  const [sec, setSec] = useState(proyecto ? 'general' : 'interfaz');
  const lider = soyLider();
  const NAV = [
    ['Equipo', proyecto ? [['general', 'General'], ['gente', 'Miembros y roles'], ['issues', 'Issues'], ['canales', 'Canales']] : []],
    ['Esta ventana', [['interfaz', 'Interfaz']]],
  ];
  return (
    <TPanel id="ajustes" className="wb__grow tajustes">
      <nav className="tajustes__nav">
        <div className="tajustes__titulo">Ajustes del equipo</div>
        {NAV.map(([t, items]) => items.length > 0 && (
          <div key={t} className="tgrupo">
            <div className="tcap">{t}</div>
            {items.map(([id, nombre]) => <button key={id} className={`tfila ${sec === id ? 'is-on' : ''}`} onClick={() => setSec(id)}><span className="tfila__n">{nombre}</span></button>)}
          </div>
        ))}
      </nav>
      <div className="tajustes__cuerpo">
        {sec === 'general' && proyecto && <General proyecto={proyecto} lider={lider} />}
        {sec === 'gente' && proyecto && <Gente proyecto={proyecto} lider={lider} />}
        {sec === 'issues' && proyecto && <AjustesIssues proyecto={proyecto} lider={lider} />}
        {sec === 'canales' && proyecto && <Canales proyecto={proyecto} lider={lider} />}
        {sec === 'interfaz' && <Interfaz />}
      </div>
    </TPanel>
  );
}
