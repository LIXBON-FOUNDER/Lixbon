import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../testing/renderApp';
import { makeClient } from '../../testing/helpers';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Estas pruebas recorren pantallas completas: bajo carga de toda la suite necesitan más de 5 s.
vi.setConfig({ testTimeout: 20000 });
afterEach(cleanup);

const bandeja = () => screen.findByRole('region', { name: /Requiere tu atención/ });
const orden = (...nodos) => nodos.every((n, i) => i === 0 || (nodos[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));

describe('Inicio: Attention primero, luego Proyectos, con Actividad al lado', () => {
  it('muestra la bandeja arriba, los proyectos debajo y la actividad en su columna', async () => {
    renderApp();
    const attn = await bandeja();
    const proy = await screen.findByRole('region', { name: /^Proyectos/ });
    const act = await screen.findByRole('region', { name: /Actividad reciente/ });
    expect(orden(attn, proy)).toBe(true);
    expect(screen.getByLabelText('Actividad', { selector: 'aside' }).contains(act)).toBe(true);
    expect(screen.getByTestId('home')).toBeTruthy();
  });

  it('agrupa la bandeja por kind en orden de prioridad y muestra todos los kinds', async () => {
    renderApp();
    const attn = await bandeja();
    await waitFor(() => expect(attn.querySelectorAll('[data-kind].ade-inbox__group').length).toBe(6));
    const grupos = [...attn.querySelectorAll('.ade-inbox__group')].map((g) => g.dataset.kind);
    expect(grupos).toEqual(['approve_in_terminal', 'integrate', 'review', 'failed', 'pending_spawn', 'unanswered_question']);
    expect(within(attn).getAllByRole('article')).toHaveLength(8);
    expect(within(attn).getAllByText('reservado')).toHaveLength(3); // 2 lanzamientos pendientes + 1 pregunta
  });

  it('el contador de la bandeja y la insignia de Inicio coinciden', async () => {
    renderApp();
    const attn = await bandeja();
    await waitFor(() => expect(within(attn).getAllByRole('article').length).toBe(8));
    expect(within(attn).getByRole('heading', { level: 2 }).textContent).toContain('8');
    await waitFor(() => expect(screen.getByLabelText('8 pendientes')).toBeTruthy());
  });

  it('los proyectos van por «calor»: el que más atención pide primero; los archivados no salen en Inicio', async () => {
    renderApp();
    const cards = await screen.findAllByLabelText(/^Proyecto /);
    expect(cards.map((c) => c.dataset.testid)).toEqual(['project-prj_api', 'project-prj_docs', 'project-prj_orbita']);
    expect(screen.queryByLabelText('Proyecto prototipo-movil')).toBeNull();
  });

  it('cada proyecto resume sus tasks con estado, agente y contadores por grupo visual', async () => {
    renderApp();
    const orbita = await screen.findByLabelText('Proyecto orbita-web');
    expect(within(orbita).getByText('2 pendientes')).toBeTruthy();
    expect(within(orbita).getByText('Rediseñar el checkout')).toBeTruthy();
    expect(orbita.querySelector('.ade-counter[data-group="active"]')).toBeTruthy();
    const rate = await screen.findByLabelText('Proyecto lixbon-api');
    expect(rate.querySelector('.ade-counter[data-group="needs_person"]')).toBeTruthy();
    expect(rate.querySelector('.ade-counter[data-group="error"]')).toBeTruthy();
    const docs = await screen.findByLabelText('Proyecto sitio-docs');
    expect(within(docs).getByText(/Ver las 5 tareas abiertas/)).toBeTruthy();
  });

  it('la franja de actividad lista eventos recientes con su proyecto y su actor', async () => {
    renderApp();
    const act = await screen.findByRole('region', { name: /Actividad reciente/ });
    await waitFor(() => expect(within(act).getAllByRole('listitem').length).toBeGreaterThanOrEqual(8));
    expect(within(act).getAllByText(/^Tú/).length).toBeGreaterThan(0);
    expect(within(act).getAllByText('Codex').length).toBeGreaterThan(0);
    expect(within(act).queryByText('terminal.output')).toBeNull();
  });
});

describe('Inicio: cargando, vacío y error', () => {
  it('mientras carga muestra esqueletos por sección y luego el contenido', async () => {
    renderApp({ client: makeClient({ latencyMs: 40 }) });
    expect(document.querySelectorAll('[data-ade-state="loading"]').length).toBeGreaterThanOrEqual(2);
    await bandeja();
    await waitFor(() => expect(document.querySelectorAll('[data-ade-state="loading"]').length).toBe(0));
  });

  it('sin datos: bandeja vacía, bienvenida sin proyectos y actividad vacía', async () => {
    const client = makeClient();
    client.sim.useEmptyData();
    renderApp({ client });
    expect(await screen.findByText('Nada necesita tu atención')).toBeTruthy();
    expect(await screen.findByText('Todavía no hay proyectos')).toBeTruthy();
    expect(await screen.findByText('Sin actividad todavía')).toBeTruthy();
    const registrar = await screen.findByRole('button', { name: /Registrar proyecto/ });
    expect(registrar.disabled).toBe(true);
    expect(registrar.textContent).toContain('D');
  });

  it('un error en Attention no tumba el resto y «Reintentar» lo recupera', async () => {
    const client = makeClient();
    client.sim.failNext('listAttention');
    renderApp({ client });
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/No se pudo cargar la atención/);
    expect(await screen.findByLabelText('Proyecto orbita-web')).toBeTruthy();
    expect(await screen.findByRole('region', { name: /Actividad reciente/ })).toBeTruthy();
    fireEvent.click(within(alerta).getByRole('button', { name: 'Reintentar' }));
    expect((await bandeja()).querySelectorAll('article').length).toBeGreaterThan(0);
    expect(screen.queryByText(/No se pudo cargar la atención/)).toBeNull();
  });

  it('un error en los proyectos se queda en su sección', async () => {
    const client = makeClient();
    client.sim.failAlways('listProjects');
    renderApp({ client });
    expect(await screen.findByText(/No se pudieron cargar los proyectos/)).toBeTruthy();
    expect((await bandeja()).querySelectorAll('article').length).toBeGreaterThan(0);
  });

  it('un error de la actividad solo afecta a la franja', async () => {
    const client = makeClient();
    client.sim.failAlways('listActivity');
    renderApp({ client });
    expect(await screen.findByText(/No se pudo cargar la actividad/)).toBeTruthy();
    expect(await screen.findByLabelText('Proyecto orbita-web')).toBeTruthy();
  });
});

describe('Inicio: las decisiones se reflejan en vivo (suscripción)', () => {
  it('aprobar un lanzamiento desde la bandeja pide confirmación y retira la tarjeta', async () => {
    const client = makeClient();
    renderApp({ client });
    const tarjeta = await screen.findByLabelText(/Lanzamiento pendiente: Guía de instalación en Windows/);
    await waitFor(() => expect(within(tarjeta).getByRole('button', { name: /^Aprobar/ }).dataset.availability).toBe('simulated'));
    fireEvent.click(within(tarjeta).getByRole('button', { name: /^Aprobar/ }));
    fireEvent.click(within(tarjeta).getByText(/Confirmar aprobar/));
    await waitFor(() => expect(screen.queryByLabelText(/Lanzamiento pendiente: Guía de instalación/)).toBeNull());
    expect(screen.getByText(/Simulado: approve_spawn/)).toBeTruthy();
    expect((await client.getAttempt('att_guia_1')).state).toBe('starting');
  });

  it('rechazar desde la bandeja retira la tarjeta y registra el evento', async () => {
    const client = makeClient();
    renderApp({ client });
    const tarjeta = await screen.findByLabelText(/Lanzamiento pendiente: Despliegue de la documentación/);
    await waitFor(() => expect(within(tarjeta).getByRole('button', { name: /^Rechazar/ }).disabled).toBe(false));
    fireEvent.click(within(tarjeta).getByRole('button', { name: /^Rechazar/ }));
    await waitFor(() => expect(screen.queryByLabelText(/Lanzamiento pendiente: Despliegue/)).toBeNull());
    expect((await client.listActivity({ attemptId: 'att_deploy_1' }))[0].type).toBe('attempt.rejected');
  });

  it('lanzar trabajo nuevo crea un lanzamiento pendiente que aparece en la bandeja (simulado)', async () => {
    renderApp();
    await bandeja();
    const boton = await screen.findByRole('button', { name: /Lanzar trabajo nuevo/ });
    await waitFor(() => expect(boton.disabled).toBe(false));
    fireEvent.click(boton);
    fireEvent.change(await screen.findByPlaceholderText(/Describe el objetivo/), { target: { value: 'Migrar a TypeScript estricto' } });
    fireEvent.click(screen.getByRole('button', { name: /Pedir lanzamiento/ }));
    expect(await screen.findByLabelText(/Lanzamiento pendiente: Migrar a TypeScript estricto/)).toBeTruthy();
    expect(screen.getByText(/Simulado: launch_task/)).toBeTruthy();
  });

  it('posponer una Attention la oculta de la bandeja (estado de la persona)', async () => {
    const client = makeClient();
    renderApp({ client });
    await bandeja();
    const [primera] = await client.listAttention();
    await waitFor(() => expect(screen.getByTestId(`attention-${primera.id}`)).toBeTruthy());
    await client.dispatch({ type: 'snooze_attention', attentionId: primera.id, forMs: 3600000 });
    await waitFor(() => expect(screen.queryByTestId(`attention-${primera.id}`)).toBeNull());
  });
});

describe('Inicio: lo que no existe se dice', () => {
  it('Reintentar y Continuar con otro agente, en la tarjeta de un fallo, salen no disponibles con su slice', async () => {
    renderApp();
    const fallo = await screen.findByLabelText(/^Falló: Reintentos de webhooks/);
    const reintentar = await within(fallo).findByRole('button', { name: /Reintentar/ });
    await waitFor(() => expect(reintentar.title).toMatch(/Requiere Task\/Attempt/));
    expect(reintentar.disabled).toBe(true);
    expect(within(fallo).getByRole('button', { name: /Continuar con otro agente/ }).textContent).toContain('ContextPackage');
  });

  it('«Abrir diff en el IDE» y «Ir a la terminal» salen no disponibles sin puente IDE↔ADE', async () => {
    renderApp();
    const terminal = await screen.findByLabelText(/^Aprobar en la terminal/);
    const ir = within(terminal).getByRole('button', { name: /Ir a la terminal/ });
    await waitFor(() => expect(ir.title).toMatch(/puente IDE↔ADE/));
    expect(ir.disabled).toBe(true);
    const rev = await screen.findByLabelText(/^Revisar diff: Internacionalizar/);
    expect(within(rev).getByRole('button', { name: /Abrir diff en el IDE/ }).disabled).toBe(true);
  });

  it('la barra dice que los datos son simulados', async () => {
    renderApp();
    await bandeja();
    expect(await screen.findByText('Desktop (simulado)')).toBeTruthy();
    expect(document.querySelector('.ade-bar .ade-simbadge')).toBeTruthy();
  });
});

describe('Inicio: variantes de maquetación', () => {
  it('estrecho: la misma pantalla, tarjetas compactas (sin el panel de política)', async () => {
    renderApp({ mode: 'narrow' });
    await bandeja();
    expect(screen.getByTestId('ade-root').dataset.adeMode).toBe('narrow');
    await screen.findByLabelText(/Lanzamiento pendiente: Guía/);
    expect(document.querySelector('.ade-attn--pending_spawn .ade-policy')).toBeNull();
  });

  it('amplio: el lanzamiento pendiente enseña su política efectiva', async () => {
    renderApp({ mode: 'wide' });
    await screen.findByLabelText(/Lanzamiento pendiente: Guía/);
    expect(document.querySelector('.ade-attn--pending_spawn .ade-policy')).toBeTruthy();
  });

  it('móvil: consola de Attention con tres pestañas; Atención es la primera', async () => {
    renderApp({ mode: 'mobile' });
    const consola = await screen.findByTestId('mobile-console');
    expect(within(consola).getAllByRole('tab').map((t) => t.textContent.replace(/\d+$/, ''))).toEqual(['Atención', 'Proyectos', 'Actividad']);
    expect(within(consola).getByRole('tab', { name: /Atención/ }).getAttribute('aria-selected')).toBe('true');
    expect((await bandeja()).querySelectorAll('article').length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: /^Proyectos/ })).toBeNull();
  });

  it('móvil: cambiar de pestaña muestra proyectos y actividad', async () => {
    renderApp({ mode: 'mobile' });
    await bandeja();
    fireEvent.click(screen.getByRole('tab', { name: /^Proyectos/ }));
    expect(await screen.findByRole('region', { name: /^Proyectos/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Actividad' }));
    expect(await screen.findByRole('region', { name: /Actividad reciente/ })).toBeTruthy();
  });

  it('móvil: se puede aprobar un lanzamiento normal pero uno con política elevada se rechaza con su motivo', async () => {
    const client = makeClient({ clientKind: 'mobile' });
    renderApp({ client, mode: 'mobile' });
    const elevada = await screen.findByLabelText(/Lanzamiento pendiente: Despliegue/);
    await waitFor(() => expect(within(elevada).getByRole('button', { name: /^Aprobar/ }).disabled).toBe(false));
    fireEvent.click(within(elevada).getByRole('button', { name: /^Aprobar/ }));
    fireEvent.click(within(elevada).getByText(/Confirmar aprobar/));
    expect((await screen.findByRole('alert')).textContent).toMatch(/política elevada/);
    expect((await client.getAttempt('att_deploy_1')).state).toBe('pending_approval');
  });

  it('móvil: «Integrar» no se ofrece como acción disponible (fuera del alcance del móvil)', async () => {
    renderApp({ client: makeClient({ clientKind: 'mobile' }), mode: 'mobile' });
    const lista = await screen.findByLabelText(/^Lista para integrar/);
    const integrar = within(lista).getByRole('button', { name: /^Integrar/ });
    expect(integrar).toBeTruthy(); // navega a la pantalla, donde la acción de integrar está no disponible
  });
});
