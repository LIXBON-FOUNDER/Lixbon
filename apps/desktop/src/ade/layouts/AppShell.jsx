// AppShell.jsx — estructura del ADE: navegación, barra de estado y contenido, adaptada por modo.
//
//  wide   : navegación lateral con etiquetas + contenido (las pantallas usan lista/detalle y columna lateral).
//  narrow : carril de navegación solo con iconos (panel junto al IDE); el detalle reemplaza a la lista.
//  mobile : barra inferior y una sola columna (consola de Attention).
import { useRef } from 'react';
import { LayoutContext, useLayoutMode } from './layoutMode';
import { NAV_ITEMS, navSectionOf, routes } from '../navigation/routes';
import { useNav } from '../navigation/useAdeRouter';
import { AdeIcon } from '../components/AdeIcon';
import { NavLink } from '../components/NavLink';
import { SimBadge, AdeNotices } from '../components/small';
import { useAde } from '../state/AdeProvider';
import { useAdeQuery } from '../state/useAdeQuery';
import { visibleAttention } from '../domain-view/attention';

function useAttentionBadge() {
  const { now } = useAde();
  const q = useAdeQuery((c) => c.listAttention(), []);
  return Array.isArray(q.data) ? visibleAttention(q.data, now()).length : null;
}

function ConnectionPill() {
  const { connection, capabilitiesError } = useAde();
  if (capabilitiesError) return <span className="ade-conn is-error" title={capabilitiesError.message}>Sin conexión con el Core</span>;
  if (!connection) return <span className="ade-conn">Conectando…</span>;
  return (
    <span className="ade-conn" title={`Fuente: ${connection.source}. Modo del Core: ${connection.coreMode}.`}>
      {connection.label}
      {connection.source === 'mock' && <SimBadge />}
    </span>
  );
}

export function AppShell({ children, mode: forced, title = 'Lixbon ADE' }) {
  const ref = useRef(null);
  const mode = useLayoutMode(ref, forced);
  const { route } = useNav();
  const activa = navSectionOf(route);
  const pendientes = useAttentionBadge();
  const items = mode === 'mobile' ? NAV_ITEMS.filter((i) => i.screen !== 'agents') : NAV_ITEMS;

  return (
    <LayoutContext.Provider value={{ mode }}>
      <div className="ade" data-ade-mode={mode} ref={ref} data-testid="ade-root">
        <header className="ade-bar">
          <span className="ade-bar__title">{title}</span>
          <ConnectionPill />
        </header>
        <nav className="ade-nav" aria-label="Navegación del ADE">
          {items.map((i) => (
            <NavLink key={i.screen} route={routes[i.screen]()} className={`ade-nav__item ${activa === i.screen ? 'is-active' : ''}`} aria-current={activa === i.screen ? 'page' : undefined} title={i.label}>
              <AdeIcon name={i.icon} size={mode === 'mobile' ? 20 : 17} />
              <span className="ade-nav__label">{i.label}</span>
              {i.screen === 'home' && pendientes > 0 && <span className="ade-nav__badge" aria-label={`${pendientes} pendientes`}>{pendientes}</span>}
            </NavLink>
          ))}
        </nav>
        <main className="ade-main" id="ade-main">{children}</main>
        <AdeNotices />
      </div>
    </LayoutContext.Provider>
  );
}
