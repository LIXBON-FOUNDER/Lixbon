// ScreenFrame.jsx — cabecera común de las pantallas: migas de pan, título y acciones.
import { Breadcrumbs } from '../../components/small';
import { LoadingState, ErrorState } from '../../components/states';
import { useNav } from '../../navigation/useAdeRouter';
import { breadcrumbTrail } from '../../navigation/routes';
import { useLayout } from '../../layouts/layoutMode';

export function ScreenFrame({ route, entities, title, subtitle, actions, children }) {
  const { back, canGoBack } = useNav();
  const { mode } = useLayout();
  return (
    <div className="ade-screen" data-screen={route.screen}>
      <header className="ade-screen__head">
        <div className="ade-screen__top">
          {canGoBack && mode !== 'wide' && <button type="button" className="btn btn--ghost btn--sm" onClick={back} aria-label="Volver">‹ Volver</button>}
          <Breadcrumbs trail={breadcrumbTrail(route, entities)} />
        </div>
        <div className="ade-screen__titlerow">
          <div>
            <h1 className="ade-h1">{title}</h1>
            {subtitle && <div className="ade-screen__sub">{subtitle}</div>}
          </div>
          {actions && <div className="ade-screen__actions">{actions}</div>}
        </div>
      </header>
      <div className="ade-screen__body">{children}</div>
    </div>
  );
}

/**
 * Envuelve una pantalla de detalle: mientras carga o falla, muestra el marco con la ruta (para poder volver)
 * y el estado correspondiente; con datos, delega en `children(data)`, que debe devolver un <ScreenFrame>.
 */
export function DetailBoundary({ route, query, children }) {
  if (query.data === null || query.data === undefined) {
    return (
      <ScreenFrame route={route} entities={{}} title={query.status === 'error' ? 'No se pudo abrir' : 'Cargando…'}>
        {query.status === 'error' ? <ErrorState error={query.error} onRetry={query.reload} /> : <LoadingState rows={4} />}
      </ScreenFrame>
    );
  }
  return children(query.data);
}
