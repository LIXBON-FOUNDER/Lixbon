// MobileAttentionConsole.jsx — variante móvil del Inicio: una consola de Attention, no otro IDE.
// Reorganiza las MISMAS secciones del Inicio en pestañas; no tiene lógica propia. Ofrece lo que el móvil
// debe poder hacer (ver Attention, responder, aprobar/rechazar, revisión resumida, detener) y deja
// fuera lo que no (diff completo, terminal, integrar), que además el Core rechazaría por alcance (F).
import { useState } from 'react';

const PESTANAS = [
  { id: 'attention', label: 'Atención' },
  { id: 'projects', label: 'Proyectos' },
  { id: 'activity', label: 'Actividad' },
];

export function MobileAttentionConsole({ attention, projects, activity, pendientes }) {
  const [activa, setActiva] = useState('attention');
  const contenido = { attention, projects, activity }[activa];
  return (
    <div className="ade-mobile" data-testid="mobile-console">
      <div className="ade-seg" role="tablist" aria-label="Secciones de la consola">
        {PESTANAS.map((p) => (
          <button
            key={p.id} type="button" role="tab" id={`mob-tab-${p.id}`} aria-selected={activa === p.id} aria-controls="mob-panel"
            className={`ade-seg__tab ${activa === p.id ? 'is-active' : ''}`} onClick={() => setActiva(p.id)}
          >
            {p.label}
            {p.id === 'attention' && pendientes > 0 && <span className="ade-count">{pendientes}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="mob-panel" aria-labelledby={`mob-tab-${activa}`} className="ade-mobile__panel">{contenido}</div>
    </div>
  );
}
