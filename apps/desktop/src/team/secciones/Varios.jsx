// Varios.jsx — calendario (a la espera de Google), sin proyectos y sin sesión.
import { useState } from 'react';
import { getAllWindows } from '@tauri-apps/api/window';
import { useTeamStore } from '../store/teamStore';
import { TPanel } from '../ui/Panel';
import { Aviso } from './Conectar';
import { IconPlus } from '../../components/Icons';
import { IconCalendar, IconLock } from '../ui/icons';

export function Calendario() {
  return (
    <TPanel id="calendario" className="wb__grow">
      <Aviso icono={<IconCalendar size={22} />} titulo="Calendario">
        <p>Aquí verás tu Google Calendar dentro de Lixbon Team.</p>
        <p className="tnota"><IconLock size={12} /> Falta que Google verifique el permiso de calendario, un trámite que dura semanas. Tu agenda será solo tuya.</p>
      </Aviso>
    </TPanel>
  );
}

export function SinProyectos() {
  const { crearProyecto, usuario } = useTeamStore();
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
  const [creando, setCreando] = useState(false);
  const crear = async (e) => {
    e.preventDefault();
    if (!nombre.trim()) return;
    setCreando(true);
    setError(await crearProyecto(nombre.trim()));
    setCreando(false);
  };
  return (
    <TPanel id="sin" className="wb__grow">
      <Aviso titulo="Todavía no estás en ningún proyecto">
        <p>Si vas a entrar en el equipo de otra persona, pídele que te invite con tu correo{usuario?.email ? ` (${usuario.email})` : ''}: aparecerá aquí solo.</p>
        <form className="taviso__form" onSubmit={crear}>
          <input className="tinput" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del proyecto" maxLength={60} aria-label="Nombre del proyecto" />
          <button className="btn btn--primary" type="submit" disabled={!nombre.trim() || creando}><IconPlus size={13} /> {creando ? 'Creando…' : 'Crear proyecto'}</button>
        </form>
        {error && <p className="terror">{error}</p>}
        <p className="tnota">Quien crea un proyecto es su líder: invita a la gente, crea los canales y decide quién ve los privados.</p>
      </Aviso>
    </TPanel>
  );
}

async function enfocarIde() {
  const ventanas = await getAllWindows().catch(() => []);
  await ventanas.find((w) => w.label === 'main')?.setFocus().catch(() => {});
}

export function SinSesion({ error }) {
  const reintentar = useTeamStore((s) => s.reintentar);
  return (
    <div className="tportada">
      <Aviso
        titulo={error ? 'No se pudo conectar' : 'Inicia sesión en el IDE'}
        acciones={(
          <>
            <button className="btn btn--primary" onClick={reintentar}>Reintentar</button>
            <button className="btn btn--ghost" onClick={enfocarIde}>Ir al IDE</button>
          </>
        )}
      >
        <p>{error || 'Lixbon Team usa la misma cuenta que el IDE. Entra allí y vuelve aquí.'}</p>
      </Aviso>
    </div>
  );
}
