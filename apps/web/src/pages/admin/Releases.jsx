import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { IconCheck, IconDownload } from '../../components/Icons';
import {
  Aviso, Cabecera, Celda, Chip, Fila, Tabla, Vacio, errMsg,
} from './comunes';

const COLS = 'minmax(0,1.6fr) 96px 104px 112px 112px';

const CABECERAS = [
  { label: 'Título' }, { label: 'Versión' }, { label: 'Producto' },
  { label: 'Canal' }, { label: 'Publicada' },
];

const VACIO = {
  product: 'desktop', version: '', channel: 'stable',
  title: '', changelog: '', checksum_sha256: '',
};

const pesoDe = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function Releases() {
  const [versiones, setVersiones] = useState([]);
  const [form, setForm] = useState(VACIO);
  const [archivo, setArchivo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/versions')
      .then((r) => setVersiones(r.data))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar las versiones')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const publicar = async (ev) => {
    ev.preventDefault();
    setError('');
    setOk('');
    if (!archivo) {
      setError('Selecciona el archivo del instalador.');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('product', form.product);
      fd.append('version', form.version.trim());
      fd.append('channel', form.channel);
      fd.append('title', form.title.trim());
      // El changelog viaja como JSON: una línea del textarea es una viñeta.
      const puntos = form.changelog.split('\n').map((s) => s.trim()).filter(Boolean);
      fd.append('changelog', JSON.stringify(puntos.length ? puntos : [form.title.trim()]));
      if (form.checksum_sha256.trim()) fd.append('checksum_sha256', form.checksum_sha256.trim());
      fd.append('file', archivo);

      const r = await api.post('/api/versions/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setOk(`Versión ${r.data.version} publicada (${r.data.storage}).`);
      setForm(VACIO);
      setArchivo(null);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo publicar la versión'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Cabecera
        titulo="Releases"
        lead="Instaladores del IDE y del APK. La descarga se sirve por URL firmada desde el almacenamiento privado."
      >
        <Link to="/aplicaciones" className="adm-btn">Ver página pública</Link>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>
        <Aviso>{ok}</Aviso>

        <div className="adm-lateral">
          <form className="adm-card" onSubmit={publicar}>
            <h2 className="adm-card__title">Publicar una versión</h2>

            <div className="adm-campos">
              <label className="adm-campo">
                <span className="adm-campo__label">Producto</span>
                <select
                  className="adm-select"
                  value={form.product}
                  onChange={(e) => setForm({ ...form, product: e.target.value })}
                >
                  <option value="desktop">desktop (MSI)</option>
                  <option value="android">android (APK)</option>
                </select>
              </label>
              <label className="adm-campo">
                <span className="adm-campo__label">Canal</span>
                <select
                  className="adm-select"
                  value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
                >
                  <option value="stable">stable</option>
                  <option value="beta">beta</option>
                </select>
              </label>
              <label className="adm-campo adm-campo__ancho">
                <span className="adm-campo__label">Versión</span>
                <input
                  className="adm-input adm-input--mono"
                  required
                  placeholder="2.6.0"
                  value={form.version}
                  onChange={(e) => setForm({ ...form, version: e.target.value })}
                />
              </label>
              <label className="adm-campo adm-campo__ancho">
                <span className="adm-campo__label">Título</span>
                <input
                  className="adm-input"
                  required
                  placeholder="Editor más rápido en archivos grandes"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>
              <label className="adm-campo adm-campo__ancho">
                <span className="adm-campo__label">Changelog · una línea por punto</span>
                <textarea
                  className="adm-input adm-input--area"
                  rows={3}
                  placeholder={'Corrige el streaming al reconectar\nNuevo selector de modelos'}
                  value={form.changelog}
                  onChange={(e) => setForm({ ...form, changelog: e.target.value })}
                />
              </label>
              <label className="adm-campo adm-campo__ancho">
                <span className="adm-campo__label">Checksum SHA-256 (opcional)</span>
                <input
                  className="adm-input adm-input--mono"
                  placeholder="para firmar la actualización"
                  value={form.checksum_sha256}
                  onChange={(e) => setForm({ ...form, checksum_sha256: e.target.value })}
                />
              </label>
              <div className="adm-campo adm-campo__ancho">
                <span className="adm-campo__label">Instalador</span>
                <label className="adm-file">
                  <input type="file" onChange={(e) => setArchivo(e.target.files?.[0] || null)} />
                  <IconDownload size={16} />
                  <span className="adm-file__nombre">
                    {archivo ? archivo.name : 'Elegir el archivo…'}
                  </span>
                  {archivo && <span className="adm-file__peso">{pesoDe(archivo.size)}</span>}
                </label>
              </div>
            </div>

            <div className="adm-card__pie">
              <button className="adm-btn adm-btn--primary" type="submit" disabled={busy}>
                {busy ? 'Publicando…' : <><IconCheck size={15} /> Publicar versión</>}
              </button>
            </div>
          </form>

          <div className="adm-card adm-card--tabla">
            <h2 className="adm-card__title">Versiones publicadas</h2>
            {versiones.length === 0 ? (
              <Vacio>Aún no hay ninguna versión publicada.</Vacio>
            ) : (
              <Tabla cols={COLS} cabeceras={CABECERAS} ancho={640}>
                {versiones.map((v) => (
                  <Fila key={`${v.product || 'desktop'}-${v.version}-${v.channel}`} cols={COLS}>
                    <Celda>{v.title}</Celda>
                    <Celda><span className="mono">{v.version}</span></Celda>
                    <Celda><Chip mono>{v.product || 'desktop'}</Chip></Celda>
                    <Celda>
                      <Chip tono={v.channel === 'stable' ? 'ok' : 'warn'} punto>{v.channel}</Chip>
                    </Celda>
                    <Celda>
                      <span className="adm-lista__label">{v.release_date}</span>
                    </Celda>
                  </Fila>
                ))}
              </Tabla>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
