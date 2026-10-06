import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconCheck, IconFile, IconTrash } from '../../components/Icons';
import { useConfirmar } from '../../hooks/useConfirmar';
import {
  adminDeleteSkill, adminGetSkill, adminListSkills, adminPublishVersion, adminUpdateSkill, fmtPeso,
} from '../../lib/skillsApi';
import {
  Aviso, Boton, Cabecera, Celda, Chip, Fila, Tabla, Tarjeta, Vacio, errMsg, fmtFecha, fmtNum,
} from './comunes';

const COLS = 'minmax(0,1.4fr) 84px 104px 110px 96px 88px';
const CABECERAS = [
  { label: 'Skill' }, { label: 'Versión' }, { label: 'Estado' },
  { label: 'Valoración' }, { label: 'Instalaciones', num: true }, { label: '' },
];

const siguiente = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
};

async function nombreDe(files) {
  const md = [...files].find((f) => /(^|\/)SKILL\.md$/.test(f.webkitRelativePath || f.name)
    && (f.webkitRelativePath || f.name).split('/').length <= 2);
  if (!md) return null;
  const m = /^name:\s*["']?([a-z0-9-]+)/m.exec(await md.text());
  return m ? m[1] : null;
}

function Publicar({ skills, onPublicada }) {
  const [archivos, setArchivos] = useState(null);
  const [slug, setSlug] = useState(null);
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const elegir = async (files) => {
    setError('');
    setArchivos(files?.length ? files : null);
    const nombre = files?.length ? await nombreDe(files) : null;
    setSlug(nombre);
    if (!nombre && files?.length) setError('La carpeta no tiene un SKILL.md con `name` en la raíz.');
    const actual = skills.find((s) => s.slug === nombre);
    setVersion(siguiente(actual?.version));
  };

  const publicar = async (ev) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const sk = await adminPublishVersion(archivos, version.trim(), changelog);
      setArchivos(null);
      setSlug(null);
      setVersion('');
      setChangelog('');
      onPublicada(sk);
    } catch (e) {
      setError(errMsg(e, 'No se pudo publicar la versión'));
    } finally {
      setBusy(false);
    }
  };

  const peso = archivos ? [...archivos].reduce((n, f) => n + f.size, 0) : 0;
  const existe = skills.some((s) => s.slug === slug);
  return (
    <form className="adm-card" onSubmit={publicar}>
      <h2 className="adm-card__title">Publicar una versión</h2>
      <div className="adm-campos">
        <div className="adm-campo adm-campo__ancho">
          <span className="adm-campo__label">Carpeta de la skill (con SKILL.md)</span>
          <label className="adm-file">
            <input type="file" webkitdirectory="" directory="" multiple
              onChange={(e) => elegir(e.target.files)} />
            <IconFile size={16} />
            <span className="adm-file__nombre">
              {slug ? `/${slug}${existe ? '' : ' · nueva'}` : 'Elegir la carpeta…'}
            </span>
            {archivos && <span className="adm-file__peso">{archivos.length} archivos · {fmtPeso(peso)}</span>}
          </label>
        </div>
        <label className="adm-campo adm-campo__ancho">
          <span className="adm-campo__label">Versión</span>
          <input className="adm-input adm-input--mono" required pattern="\d+\.\d+\.\d+" placeholder="1.0.0"
            value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
        <label className="adm-campo adm-campo__ancho">
          <span className="adm-campo__label">Cambios</span>
          <textarea className="adm-input adm-input--area" rows={3}
            placeholder="Revisa cada imagen con visual_view antes de entregar"
            value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        </label>
      </div>
      <Aviso error>{error}</Aviso>
      <p className="adm-vacio">Se omiten evals/, __pycache__ y .git. Una skill nueva queda oculta hasta que completes su ficha.</p>
      <div className="adm-card__pie">
        <button className="adm-btn adm-btn--primary" type="submit" disabled={busy || !archivos || !slug}>
          {busy ? 'Publicando…' : <><IconCheck size={15} /> Publicar versión</>}
        </button>
      </div>
    </form>
  );
}

function Ficha({ slug, onCambio, onBorrada }) {
  const confirmar = useConfirmar();
  const [sk, setSk] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    setSk(null);
    adminGetSkill(slug).then((d) => {
      setSk(d);
      setForm({ title: d.title, summary: d.summary, category: d.category || '', description_md: d.description_md });
    }).catch((e) => setError(errMsg(e, 'No se pudo cargar la skill')));
  }, [slug]);

  const guardar = async (extra = {}) => {
    setBusy(true);
    setError('');
    setOk('');
    try {
      const d = await adminUpdateSkill(slug, { ...form, category: form.category.trim() || null, ...extra });
      setSk(d);
      setOk(extra.published === undefined ? 'Ficha guardada.' : d.published ? 'Skill visible en el catálogo.' : 'Skill oculta.');
      onCambio();
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar'));
    } finally {
      setBusy(false);
    }
  };

  const borrar = async () => {
    const si = await confirmar({
      titulo: `¿Eliminar /${slug}?`,
      texto: 'Se borran todas sus versiones, instalaciones y valoraciones. Quien ya la instaló la conserva.',
      etiqueta: 'Eliminar',
      peligro: true,
    });
    if (!si) return;
    await adminDeleteSkill(slug);
    onBorrada();
  };

  if (!sk || !form) return <Tarjeta titulo={`/${slug}`}><Aviso error>{error}</Aviso></Tarjeta>;
  const campo = (k) => ({ value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <Tarjeta titulo={`/${slug}`} extra={(
      <div className="adm__actions">
        <a className="adm-btn adm-btn--sm" href={`/skills/${slug}`} target="_blank" rel="noreferrer">Ver ficha pública</a>
        <Boton sm onClick={() => guardar({ published: !sk.published })} disabled={busy}>
          {sk.published ? 'Ocultar' : 'Mostrar en el catálogo'}
        </Boton>
        <Boton sm peligro onClick={borrar} aria-label="Eliminar skill"><IconTrash size={14} /></Boton>
      </div>
    )}>
      <Aviso error>{error}</Aviso>
      <Aviso>{ok}</Aviso>
      <div className="adm-campos">
        <label className="adm-campo">
          <span className="adm-campo__label">Título</span>
          <input className="adm-input" maxLength={80} {...campo('title')} />
        </label>
        <label className="adm-campo">
          <span className="adm-campo__label">Categoría</span>
          <input className="adm-input" maxLength={40} placeholder="Marketing" {...campo('category')} />
        </label>
        <label className="adm-campo adm-campo__ancho">
          <span className="adm-campo__label">Resumen · una línea, para la tarjeta</span>
          <input className="adm-input" maxLength={240} {...campo('summary')} />
        </label>
        <label className="adm-campo adm-campo__ancho">
          <span className="adm-campo__label">Descripción detallada · Markdown</span>
          <textarea className="adm-input adm-input--area" rows={12} {...campo('description_md')} />
        </label>
      </div>
      <div className="adm-card__pie">
        <button className="adm-btn adm-btn--primary" type="button" onClick={() => guardar()} disabled={busy}>
          <IconCheck size={15} /> Guardar ficha
        </button>
      </div>
      <h3 className="adm-card__title">Versiones</h3>
      {sk.versions.map((v) => (
        <p key={v.version} className="adm-vacio">
          <span className="mono">v{v.version}</span> · {fmtFecha(v.released_at)} · {fmtPeso(v.size)}
          {v.changelog ? ` — ${v.changelog}` : ''}
        </p>
      ))}
    </Tarjeta>
  );
}

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [abierta, setAbierta] = useState(null);
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    adminListSkills().then(setSkills).catch((e) => setError(errMsg(e, 'No se pudieron cargar las skills')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  return (
    <>
      <Cabecera titulo="Skills" lead="Catálogo oficial que se instala desde Ajustes › Skills del IDE y desde lixbon.com/skills.">
        <Link to="/skills" className="adm-btn">Ver página pública</Link>
      </Cabecera>
      <div className="adm__body">
        <Aviso error>{error}</Aviso>
        <Aviso>{ok}</Aviso>
        <div className="adm-lateral">
          <Publicar skills={skills} onPublicada={(sk) => {
            setOk(`/${sk.slug} v${sk.version} publicada${sk.published ? '' : ' (oculta)'}.`);
            setAbierta(sk.slug);
            cargar();
          }} />
          <div className="adm-card adm-card--tabla">
            <h2 className="adm-card__title">Skills</h2>
            {skills.length === 0 ? <Vacio>Aún no hay skills. Sube la carpeta de una para empezar.</Vacio> : (
              <Tabla cols={COLS} cabeceras={CABECERAS} ancho={640}>
                {skills.map((s) => (
                  <Fila key={s.slug} cols={COLS}>
                    <Celda><span className="mono">/{s.slug}</span> · {s.title}</Celda>
                    <Celda><span className="mono">{s.version || '—'}</span></Celda>
                    <Celda>
                      <Chip tono={s.published ? 'ok' : 'warn'} punto>{s.published ? 'Visible' : 'Oculta'}</Chip>
                    </Celda>
                    <Celda>{s.rating_count ? `${s.rating_avg.toFixed(1)} ★ (${s.rating_count})` : '—'}</Celda>
                    <Celda num>{fmtNum(s.installs)}</Celda>
                    <Celda acciones>
                      <Boton sm onClick={() => setAbierta(s.slug)}>Editar</Boton>
                    </Celda>
                  </Fila>
                ))}
              </Tabla>
            )}
          </div>
        </div>
        {abierta && (
          <Ficha key={abierta} slug={abierta} onCambio={cargar}
            onBorrada={() => { setAbierta(null); setOk('Skill eliminada.'); cargar(); }} />
        )}
      </div>
    </>
  );
}
