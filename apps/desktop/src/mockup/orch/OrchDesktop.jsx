// OrchDesktop.jsx — modo Orquestador del Desktop de Lixbon (maqueta con datos ficticios).
// Pregunta de la pantalla: ¿qué necesita de mí el equipo de agentes y qué está listo para integrar?
// Marco: tres paneles flotantes sobre el fondo (árbol · lienzo · detalles), 8 px de hueco; jerarquía por relleno, sin bordes.
import React, { useEffect } from 'react';
import { useOrch, fleetCounts } from './orchStore';
import { PROJECT } from './orchData';
import { OrchTree } from './OrchTree';
import { OrchRunView } from './OrchRunView';
import { OrchTaskView } from './OrchTaskView';
import { OrchInspector, SpawnDetail, FleetView, TeamView } from './OrchPanels';
import { OrchDialogs, Toasts, SimMenu } from './OrchDialogs';
import { Seg, I } from './orchUi';
import './orch.css';

function Canvas() {
  const s = useOrch();
  if (s.view === 'fleet') return <FleetView />;
  if (s.view === 'team') return <TeamView />;
  if (s.sel.startsWith('p') && s.pending.some((p) => p.id === s.sel)) return <SpawnDetail id={s.sel} />;
  const t = s.tasks.find((x) => x.id === s.sel);
  if (t && !t.parent) return <OrchRunView />;
  return <OrchTaskView />;
}

export default function OrchDesktop() {
  const s = useOrch();
  const f = fleetCounts(s);
  const showInsp = s.view === 'runs' && !(s.sel.startsWith('p') && s.pending.some((p) => p.id === s.sel));

  // Las tareas en marcha escriben en su terminal de vez en cuando (simulado).
  useEffect(() => {
    const id = setInterval(() => useOrch.getState().tickLive(), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="o-app mkr" data-ui="orch">
      <header className="o-top">
        <span className="o-brand" aria-label="Lixbon"><i aria-hidden="true" />LIXBON</span>
        <button type="button" className="o-scope" title="Proyecto y rama del coordinador">
          <I n="folder" size={13} /><b>{PROJECT.name}</b><span className="mono">{PROJECT.coordBranch}</span>
        </button>
        <Seg value={s.view} onChange={s.setView} label="Vista del Orquestador" options={[
          { id: 'runs', label: 'Ejecuciones', count: f.attention || undefined },
          { id: 'fleet', label: 'Flota' },
          { id: 'team', label: 'Equipo' },
        ]} />
        <span className="o-top__sp" />
        <span className="o-top__stat" aria-live="polite"><i className="o-dot" aria-hidden="true" />{f.working} en marcha{f.attention ? <> · <b>{f.attention} esperan tu decisión</b></> : null}</span>
        <SimMenu />
        {s.view === 'runs' && <button type="button" className="o-ico" aria-pressed={s.inspector} aria-label={s.inspector ? 'Ocultar detalles' : 'Mostrar detalles'} title="Detalles de la tarea" onClick={s.toggleInspector}><I n="panel" size={14} /></button>}
        <button type="button" className="btn btn--primary btn--sm" onClick={() => s.openDialog({ kind: 'newrun' })}><I n="plus" size={12} /> Nuevo run</button>
      </header>

      <div className={`o-main ${s.view !== 'runs' ? 'is-wide' : ''}`}>
        {s.view === 'runs' && <OrchTree />}
        <main className="o-canvas" aria-label="Lienzo del Orquestador"><Canvas /></main>
        {showInsp && s.inspector && <OrchInspector />}
      </div>

      <OrchDialogs />
      <Toasts />
    </div>
  );
}
