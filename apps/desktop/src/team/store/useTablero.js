// useTablero.js — todo lo del equipo activo que piden las pantallas de issues,
// ya indexado: estados, etiquetas, ciclos, proyectos, gente e issues.
import { useEffect, useMemo } from 'react';
import { useTeamStore } from './teamStore';
import { useIssuesStore } from './issuesStore';
import { cicloDeHoy } from '../lib/issues';

export function useTablero(proyectoIdForzado) {
  const proyectoIdActivo = useTeamStore((s) => s.proyectoId);
  const proyectoId = proyectoIdForzado || proyectoIdActivo;
  const proyecto = useTeamStore((s) => s.proyectos.find((p) => p.id === proyectoId) || null);
  const usuario = useTeamStore((s) => s.usuario);
  const datos = useIssuesStore((s) => s.porProyecto[proyectoId]);
  const cargar = useIssuesStore((s) => s.cargar);

  useEffect(() => { if (proyectoId) cargar(proyectoId); }, [proyectoId, cargar]);

  return useMemo(() => {
    const tablero = proyecto?.tablero || { estados: [], etiquetas: [], ciclos: [], iniciativas: [], config: {}, prefijo: '' };
    const miembros = proyecto?.miembros || [];
    const porId = (lista) => Object.fromEntries(lista.map((x) => [x.id, x]));
    const gente = Object.fromEntries(miembros.map((m) => [m.usuario.id, m]));
    return {
      proyectoId,
      proyecto,
      tablero,
      usuario,
      estados: tablero.estados,
      estadosPorId: porId(tablero.estados),
      etiquetasPorId: porId(tablero.etiquetas),
      ciclosPorId: porId(tablero.ciclos),
      iniciativasPorId: porId(tablero.iniciativas),
      cicloHoy: cicloDeHoy(tablero.ciclos),
      miembros,
      gente,
      issues: datos?.issues || [],
      cargando: !datos?.cargado && !datos?.error,
      error: datos?.error || '',
      lider: proyecto?.rol === 'lider',
    };
  }, [proyectoId, proyecto, usuario, datos]);
}
