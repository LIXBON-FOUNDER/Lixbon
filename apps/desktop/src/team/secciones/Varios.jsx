// Varios.jsx — la portada cuando no hay sesión.
import { getAllWindows } from '@tauri-apps/api/window';
import { useTeamStore } from '../store/teamStore';
import { Aviso } from './Conectar';

async function enfocarIde() {
  const ventanas = await getAllWindows().catch(() => []);
  const ide = ventanas.find((w) => w.label === 'main');
  await ide?.show().catch(() => {});
  await ide?.setFocus().catch(() => {});
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
