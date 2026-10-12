// Cadena de navegación del ADE: Attention → Project → Task → Attempt → Thread/Worktree/Artifacts/Diff → IDE,
// y el camino inverso IDE → Task/Attempt. Se recorre con la interfaz real sobre el MockAdeClient.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderApp } from '../testing/renderApp';
import { makeClient } from '../testing/helpers';
import { createRecordingHost } from '../host/AdeHost';
import { routes } from '../navigation/routes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Estas pruebas recorren pantallas completas: bajo carga de toda la suite necesitan más de 5 s.
vi.setConfig({ testTimeout: 20000 });
afterEach(cleanup);

const migas = () => within(screen.getByRole('navigation', { name: 'Ruta de navegación' }));
const h1 = () => screen.getByRole('heading', { level: 1 });
const titulo = () => screen.findByRole('heading', { level: 1 });
const esperaTitulo = (texto) => waitFor(() => expect(h1().textContent).toBe(texto));

describe('cadena de trabajo: de la bandeja al detalle', () => {
  it('Inicio → Proyecto → Task → Intento → Hilo, con migas para volver a cualquier nivel', async () => {
    renderApp();
    const orbita = await screen.findByLabelText('Proyecto orbita-web');
    fireEvent.click(within(orbita).getByRole('link', { name: 'orbita-web' }));
    await esperaTitulo('orbita-web');
    expect(screen.getByText('Tareas')).toBeTruthy();

    fireEvent.click(await screen.findByRole('link', { name: 'Rediseñar el checkout' }));
    await esperaTitulo('Rediseñar el checkout');
    expect(migas().getAllByRole('link').map((l) => l.textContent)).toEqual(['Inicio', 'orbita-web']);
    expect(await screen.findByTestId('attempt-att_checkout_1')).toBeTruthy();
    expect(screen.getByTestId('attempt-att_checkout_2')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('attempt-att_checkout_2')).getByRole('link', { name: 'Intento 2' }));
    await esperaTitulo('Rediseñar el checkout · Intento 2');
    expect(migas().getAllByRole('link').map((l) => l.textContent)).toEqual(['Inicio', 'orbita-web', 'Rediseñar el checkout']);

    fireEvent.click(await screen.findByRole('link', { name: 'Checkout: hilo principal' }));
    await esperaTitulo('Checkout: hilo principal');
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/Solo metadatos \(predeterminada\)/)).toBeTruthy();

    fireEvent.click(migas().getByRole('link', { name: 'orbita-web' }));
    await esperaTitulo('orbita-web');
    fireEvent.click(migas().getByRole('link', { name: 'Inicio' }));
    expect(await screen.findByTestId('home')).toBeTruthy();
  });

  it('una tarjeta de Attention de «review» va directo a la Revisión, que cuelga del intento', async () => {
    renderApp();
    const tarjeta = await screen.findByLabelText(/^Revisar diff: Internacionalizar/);
    fireEvent.click(within(tarjeta).getByRole('button', { name: 'Revisar diff' }));
    await esperaTitulo('Revisión · Internacionalizar mensajes de error');
    expect(migas().getAllByRole('link').map((l) => l.textContent)).toEqual(['Inicio', 'orbita-web', 'Internacionalizar mensajes de error', 'Intento 1']);
    expect(await screen.findByTestId('diffstat')).toHaveProperty('textContent', expect.stringContaining('31'));
  });

  it('Revisar → Integrar de principio a fin (simulado): la Attention desaparece y la Task queda integrada', async () => {
    const client = makeClient();
    renderApp({ client, initialRoute: routes.review('att_i18n_1') });
    const aceptar = await screen.findByRole('button', { name: /Aceptar este commit/ });
    await waitFor(() => expect(aceptar.disabled).toBe(false));
    fireEvent.click(aceptar);
    fireEvent.click(await screen.findByText(/Confirmar aceptar este commit/));
    await waitFor(() => expect(screen.getByText('Aceptada', { selector: '.ade-chip' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Ir a integrar' }));
    const integrar = await screen.findByRole('button', { name: /^Integrar/ });
    await waitFor(() => expect(integrar.disabled).toBe(false));
    fireEvent.click(integrar);
    fireEvent.click(await screen.findByText(/Confirmar integrar/));
    await waitFor(() => expect(screen.getByText(/Integrada/)).toBeTruthy());
    expect((await client.getTask('tsk_i18n')).derivedState).toBe('integrated');
    expect((await client.listAttention()).some((i) => i.attemptId === 'att_i18n_1')).toBe(false);
  });

  it('la integración sin revisión aceptada se explica y no se puede pedir', async () => {
    renderApp({ initialRoute: routes.integration('att_i18n_1') });
    expect((await screen.findByTestId('not-eligible')).textContent).toMatch(/revisión aceptada/);
    expect(screen.getByRole('button', { name: /^Integrar/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Ir a revisar' })).toBeTruthy();
  });

  it('una revisión desactualizada lo dice y obliga a decidir sobre el commit actual', async () => {
    renderApp({ initialRoute: routes.review('att_logs_1') });
    expect(await screen.findByText('desactualizado')).toBeTruthy();
    expect(screen.getAllByText('Desactualizada').length).toBeGreaterThan(0);
  });
});

describe('pantallas de detalle', () => {
  it('Proyecto: atención propia, tareas agrupadas por estado derivado y actividad', async () => {
    renderApp({ initialRoute: routes.project('prj_api') });
    await esperaTitulo('lixbon-api');
    expect(await screen.findByText('Requiere tu atención')).toBeTruthy();
    const grupos = [...document.querySelectorAll('.ade-taskgroup')].map((g) => g.dataset.derived);
    expect(grupos).toEqual(['in_progress', 'in_review']);
    expect(screen.getByText('Actividad del proyecto')).toBeTruthy();
  });

  it('Task con varios intentos: comparar, competir, reintentar y continuar visibles pero no disponibles', async () => {
    renderApp({ initialRoute: routes.task('tsk_webhook') });
    await esperaTitulo('Reintentos de webhooks de Stripe');
    await waitFor(() => expect(screen.getByRole('button', { name: /Comparar intentos/ }).title).toMatch(/Task\/Attempt/));
    for (const [nombre, slice] of [[/Reintentar/, 'Task/Attempt'], [/Continuar con otro agente/, 'ContextPackage'], [/Competir N agentes/, 'Task/Attempt'], [/Comparar intentos/, 'Task/Attempt']]) {
      const botones = screen.getAllByRole('button', { name: nombre });
      for (const b of botones) {
        expect(b.disabled, String(nombre)).toBe(true);
        expect(b.textContent).toContain(slice);
      }
    }
    expect(screen.getByTestId('attempt-att_webhook_1')).toBeTruthy();
    expect(screen.getByTestId('attempt-att_webhook_2')).toBeTruthy();
  });

  it('Task sin intentos: estado vacío que explica qué es un intento', async () => {
    renderApp({ initialRoute: routes.task('tsk_idea') });
    expect(await screen.findByText('Esta tarea aún no tiene intentos')).toBeTruthy();
  });

  it('Intento: agente, estado, worktree, artefactos, revisión y atajos al IDE', async () => {
    renderApp({ initialRoute: routes.attempt('att_pago_1') });
    await esperaTitulo('Pago con tarjeta 3-D Secure · Intento 1');
    const wt = await screen.findByTestId('worktree');
    expect(within(wt).getByText('lxo/att_pago_1')).toBeTruthy();
    expect(screen.getByText('Informe del intento')).toBeTruthy();
    expect(screen.getByText(/Diff contra main/)).toBeTruthy();
    expect(screen.getAllByText('Aceptada').length).toBeGreaterThan(0);
    const atajos = screen.getByRole('group', { name: 'Atajos al IDE' });
    await waitFor(() => expect(within(atajos).getAllByRole('button')).toHaveLength(4));
    for (const b of within(atajos).getAllByRole('button')) expect(b.disabled).toBe(true);
  });

  it('Intento con pregunta pendiente: se responde desde la propia pantalla', async () => {
    const client = makeClient();
    renderApp({ client, initialRoute: routes.attempt('att_rate_1') });
    expect(await screen.findByText(/clave de API o por organización/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tu respuesta'), { target: { value: 'Por clave' } });
    const enviar = screen.getByRole('button', { name: /Enviar respuesta/ });
    await waitFor(() => expect(enviar.disabled).toBe(false));
    fireEvent.click(enviar);
    await waitFor(() => expect(screen.queryByText('Pregunta del agente')).toBeNull());
    expect((await client.getAttempt('att_rate_1')).state).toBe('running');
  });

  it('Intento esperando en la terminal: plazo, y ninguna acción de aprobar', async () => {
    renderApp({ initialRoute: routes.attempt('att_migr_1') });
    expect(await screen.findByText(/vence en 6:00/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Aprobar/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Detener/ })).toBeTruthy();
  });

  it('Intento pendiente de aprobación: política elevada a la vista y aprobar/rechazar', async () => {
    renderApp({ initialRoute: routes.attempt('att_deploy_1') });
    expect(await screen.findByText('Política elevada')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Aprobar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Rechazar/ })).toBeTruthy();
    expect(screen.getByText(/aún no tiene worktree/)).toBeTruthy();
    expect(screen.getByText('propuesta')).toBeTruthy();
  });

  it('Intento fallido: motivo del fallo en español', async () => {
    renderApp({ initialRoute: routes.attempt('att_webhook_2') });
    expect(await screen.findByText('Nadie aprobó en la terminal a tiempo')).toBeTruthy();
  });

  it('Actividad: filtra por proyecto', async () => {
    renderApp({ initialRoute: routes.activity() });
    await screen.findByRole('list');
    const antes = screen.getAllByRole('listitem').length;
    fireEvent.change(screen.getByLabelText('Filtrar por proyecto'), { target: { value: 'prj_docs' } });
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeLessThan(antes));
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('Agentes y proveedores: modelos, política e intentos vivos', async () => {
    renderApp({ initialRoute: routes.agents() });
    const claude = await screen.findByTestId('agent-claude');
    expect(within(claude).getByText(/Sonnet 5.5, Opus 5, Haiku 5/)).toBeTruthy();
    expect(within(screen.getByTestId('agent-opencode')).getByText('No disponible')).toBeTruthy();
    expect(within(claude).getByText('Intentos vivos').nextSibling.textContent).toBe('4');
  });

  it('Proyectos: archivados plegados y rutas ausentes avisadas', async () => {
    renderApp({ initialRoute: routes.projects() });
    expect(await screen.findByLabelText('Proyecto orbita-web')).toBeTruthy();
    expect(screen.getByText('Archivados (1)')).toBeTruthy();
    expect(screen.getAllByText('ruta ausente').length).toBeGreaterThan(0);
  });

  it('Ajustes: matriz de capacidades honesta, kinds vigentes/reservados y controles de simulación', async () => {
    renderApp({ initialRoute: routes.settings() });
    const matriz = await screen.findByTestId('capability-matrix');
    await waitFor(() => expect(matriz.querySelector('[data-intent="stop_attempt"]').dataset.availability).toBe('simulated'));
    const fila = (id) => matriz.querySelector(`[data-intent="${id}"]`);
    expect(fila('retry_attempt').dataset.availability).toBe('unavailable');
    expect(fila('retry_attempt').textContent).toContain('Task/Attempt');
    expect(fila('continue_with_other_agent').textContent).toContain('ContextPackage');
    expect(fila('snooze_attention').textContent).toContain('G');
    expect(fila('open_diff').dataset.availability).toBe('unavailable');
    expect(fila('open_diff').textContent).toContain('Cliente (host)');
    const kinds = screen.getByTestId('attention-kinds');
    expect(within(kinds).getAllByText('vigente')).toHaveLength(4);
    expect(within(kinds).getAllByText('reservado')).toHaveLength(2);
    expect(screen.getByText(/no hay severidad definida/)).toBeTruthy();
    expect(screen.getByTestId('sim-controls')).toBeTruthy();
    expect(screen.getByText('Simulada (mock en memoria)')).toBeTruthy();
  });

  it('Ajustes: «Provocar errores» en Attention se refleja en el Inicio y «Restablecer datos» lo arregla', async () => {
    const client = makeClient();
    renderApp({ client, initialRoute: routes.settings() });
    fireEvent.click(await screen.findByRole('button', { name: /Provocar errores en Atención/ }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegación del ADE' })).getByRole('link', { name: /Inicio/ }));
    expect((await screen.findAllByRole('alert')).some((n) => /No se pudo cargar la atención/.test(n.textContent))).toBe(true);
  });

  it('un id que no existe muestra el error con migas para salir, sin pantalla en blanco', async () => {
    renderApp({ initialRoute: routes.attempt('att_inexistente') });
    expect(await screen.findByText('No se pudo abrir')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/No existe el intento/);
    expect(migas().getByRole('link', { name: 'Inicio' })).toBeTruthy();
  });

  it('el botón Volver aparece en modo estrecho y retrocede', async () => {
    renderApp({ mode: 'narrow', initialRoute: routes.home() });
    fireEvent.click((await screen.findAllByRole('link', { name: 'Agentes' }))[0]);
    await titulo();
    fireEvent.click(await screen.findByRole('button', { name: 'Volver' }));
    expect(await screen.findByTestId('home')).toBeTruthy();
  });

  it('la navegación principal marca la sección activa; los detalles pertenecen a Proyectos', async () => {
    renderApp({ initialRoute: routes.task('tsk_pago') });
    await titulo();
    expect(screen.getByRole('link', { name: /Proyectos/ }).getAttribute('aria-current')).toBe('page');
    expect(within(screen.getByRole('navigation', { name: 'Navegación del ADE' })).getByRole('link', { name: /Inicio/ }).getAttribute('aria-current')).toBeNull();
  });
});

describe('camino inverso: IDE → Task/Attempt → estado del agente → Review/Attention', () => {
  const ide = { path: '%LOCALAPPDATA%/Lixbon/worktrees/prj_orbita/att_pago_1/src/pago.js' };

  it('un archivo del worktree de un intento muestra su Task, agente, estado y Attention', async () => {
    renderApp({ ideContext: ide });
    const panel = await screen.findByTestId('ide-context');
    expect(within(panel).getAllByRole('link', { name: 'Pago con tarjeta 3-D Secure' }).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Intento 1').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Terminada').length).toBeGreaterThan(0);
    expect(await within(panel).findByLabelText(/^Lista para integrar/)).toBeTruthy();
  });

  it('desde el panel se salta a la Task y a la Revisión del intento', async () => {
    renderApp({ ideContext: { path: '%LOCALAPPDATA%/Lixbon/worktrees/prj_orbita/att_i18n_1/x.js' } });
    const panel = await screen.findByTestId('ide-context');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Revisar diff' }));
    await esperaTitulo('Revisión · Internacionalizar mensajes de error');
  });

  it('el estado del agente se refresca solo cuando cambia (suscripción)', async () => {
    const client = makeClient();
    renderApp({ client, ideContext: { branch: 'lxo/att_checkout_2' } });
    const panel = await screen.findByTestId('ide-context');
    expect(within(panel).getByText('Trabajando')).toBeTruthy();
    await client.dispatch({ type: 'stop_attempt', attemptId: 'att_checkout_2' });
    await waitFor(() => expect(within(screen.getByTestId('ide-context')).getByText('Detenida')).toBeTruthy());
  });

  it('dentro del proyecto pero fuera de un worktree de intento lo dice y enlaza al proyecto', async () => {
    renderApp({ ideContext: { path: 'C:/proyectos/orbita-web/src/main.js' } });
    const panel = await screen.findByLabelText('Contexto del IDE');
    expect(within(panel).getByRole('link', { name: 'orbita-web' })).toBeTruthy();
  });

  it('fuera de cualquier proyecto: estado vacío explicado', async () => {
    renderApp({ ideContext: { path: 'D:/otro/lado.txt' } });
    expect(await screen.findByText('Fuera de cualquier intento')).toBeTruthy();
  });

  it('si la resolución falla, el panel muestra el error y el resto del ADE sigue', async () => {
    const client = makeClient();
    client.sim.failAlways('resolveLocation');
    renderApp({ client, ideContext: ide });
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(await screen.findByTestId('home')).toBeTruthy();
  });
});

describe('ADE → IDE: las capacidades las pone el host', () => {
  it('con un host conectado, «Abrir diff» llega al host con el intento y no al Core', async () => {
    const host = createRecordingHost();
    const client = makeClient();
    renderApp({ host, client, initialRoute: routes.review('att_i18n_1') });
    const abrir = await screen.findByRole('button', { name: /Abrir diff completo en el IDE/ });
    await waitFor(() => expect(abrir.disabled).toBe(false));
    fireEvent.click(abrir);
    await waitFor(() => expect(host.llamadas).toHaveLength(1));
    expect(host.llamadas[0]).toMatchObject({ type: 'open_diff', attemptId: 'att_i18n_1' });
    expect(client.sim.calls).not.toContain('dispatch');
  });

  it('desde el intento, los cuatro atajos se habilitan con el host y cada uno despacha su intent', async () => {
    const host = createRecordingHost();
    renderApp({ host, initialRoute: routes.attempt('att_pago_1') });
    const atajos = await screen.findByRole('group', { name: 'Atajos al IDE' });
    await waitFor(() => expect(within(atajos).getByRole('button', { name: /Abrir worktree/ }).disabled).toBe(false));
    for (const b of within(atajos).getAllByRole('button')) fireEvent.click(b);
    await waitFor(() => expect(host.llamadas.map((l) => l.type)).toEqual(['open_diff', 'open_worktree', 'open_in_ide', 'open_terminal']));
  });
});
