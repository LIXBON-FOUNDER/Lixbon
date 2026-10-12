// renderApp.jsx — monta el ADE completo para pruebas de pantalla.
import { render, configure } from '@testing-library/react';
import { createNullHost } from '../host/AdeHost';
import { AdeApp } from '../screens/AdeApp';
import { AdeProvider } from '../state/AdeProvider';
import { NavProvider, useAdeRouter } from '../navigation/useAdeRouter';
import { formatRoute } from '../navigation/routes';
import { AdeNotices } from '../components/small';
import { fixedNow, makeClient } from './helpers';

// Con toda la suite en marcha (jsdom en paralelo) los 1000 ms por omisión de waitFor/findBy se quedan cortos.
configure({ asyncUtilTimeout: 5000 });

export function renderApp({ client = makeClient(), host = createNullHost(), mode = 'wide', initialRoute, ideContext } = {}) {
  const utils = render(<AdeApp client={client} host={host} now={fixedNow} mode={mode} initialRoute={initialRoute} ideContext={ideContext} />);
  return { client, host, ...utils };
}

function Shell({ children, initialRoute }) {
  const router = useAdeRouter({ initial: initialRoute });
  return <NavProvider value={router}>{children}<AdeNotices /><span data-testid="ruta">{formatRoute(router.route)}</span></NavProvider>;
}

/** Monta un componente suelto con cliente, host y router (muestra la ruta actual en `data-testid="ruta"`). */
export function renderWithAde(ui, { client = makeClient(), host = createNullHost(), initialRoute } = {}) {
  const utils = render(
    <AdeProvider client={client} host={host} now={fixedNow}>
      <Shell initialRoute={initialRoute}>{ui}</Shell>
    </AdeProvider>,
  );
  return { client, host, ...utils };
}
