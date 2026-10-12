import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithAde } from '../testing/renderApp';
import { makeClient, NOW } from '../testing/helpers';
import { createRecordingHost } from '../host/AdeHost';
import { StatusMark, StatusPill } from './StatusMark';
import { AgentLabel } from './AgentLabel';
import { ActionButton } from './ActionButton';
import { AttentionCard } from './AttentionCard';
import { TaskRow, AttemptLine, ActivityLine, GroupCounters } from './rows';
import { EmptyState, LoadingState, ErrorState, QueryBoundary } from './states';
import { PolicySummary } from './PolicySummary';
import { HostShortcuts } from './HostShortcuts';
import { NavLink } from './NavLink';
import { Breadcrumbs, SimBadge } from './small';
import { buildAttentionViews } from '../domain-view/attention';
import { routes } from '../navigation/routes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Estas pruebas recorren pantallas completas: bajo carga de toda la suite necesitan más de 5 s.
vi.setConfig({ testTimeout: 20000 });
afterEach(cleanup);

const esperaCapacidades = () => waitFor(() => expect(document.querySelector('[data-availability]')).toBeTruthy());

describe('StatusMark / StatusPill', () => {
  it('cada estado de Attempt usa el grupo visual del vocabulario', () => {
    const esperado = {
      pending_approval: 'needs_person', starting: 'active', running: 'active', waiting: 'waiting', awaiting_terminal_approval: 'needs_person',
      done: 'ok', failed: 'error', stopped: 'halted', exited: 'error',
    };
    for (const [estado, grupo] of Object.entries(esperado)) {
      const { container, unmount } = renderWithAde(<StatusMark state={estado} />);
      expect(container.querySelector('.ade-sm').dataset.group, estado).toBe(grupo);
      unmount();
    }
  });

  it('waiting y needs_person son ambos ámbar pero de forma distinta (no solo color)', () => {
    const { container } = renderWithAde(<><StatusMark state="waiting" /><StatusMark state="awaiting_terminal_approval" /></>);
    const [espera, persona] = container.querySelectorAll('.ade-sm');
    expect(espera.querySelector('.ade-sm__ring')).toBeTruthy();
    expect(espera.querySelector('.ade-sm__ping')).toBeNull();
    expect(persona.querySelector('.ade-sm__ping')).toBeTruthy();
    expect(persona.querySelector('.ade-sm__fill--solid')).toBeTruthy();
  });

  it('la píldora muestra la etiqueta del Desktop; pending_approval avisa de que es propuesta', () => {
    renderWithAde(<><StatusPill state="awaiting_terminal_approval" /><StatusPill state="pending_approval" /></>);
    expect(screen.getByText('Esperando aprobación en la terminal')).toBeTruthy();
    expect(screen.getByText('Pendiente de aprobación').closest('.ade-pill').title).toMatch(/propuesta/);
  });

  it('un estado desconocido no rompe: se dibuja neutro con su id', () => {
    const { container } = renderWithAde(<StatusPill state="estado_nuevo" />);
    expect(container.querySelector('.ade-pill').textContent).toBe('estado_nuevo');
    expect(container.querySelector('[data-group="desconocido"]')).toBeTruthy();
  });
});

describe('AgentLabel', () => {
  it('reutiliza AgentChip: proveedor, modelo, esfuerzo y rol', () => {
    const { container } = renderWithAde(<AgentLabel agent={{ provider: 'codex', model: 'gpt-6-sol', effort: 'high', role: 'implementador' }} />);
    expect(container.querySelector('.agentchip').textContent).toContain('Codex');
    expect(container.querySelector('.agentchip').textContent).toContain('gpt-6-sol · high');
    expect(container.querySelector('.ade-agent__role').textContent).toBe('Implementador');
  });

  it('sin rol y sin modelo solo muestra el proveedor', () => {
    const { container } = renderWithAde(<AgentLabel agent={{ provider: 'claude', model: null, effort: null, role: null }} />);
    expect(container.querySelector('.ade-agent__role')).toBeNull();
    expect(container.querySelector('.agentchip__detail')).toBeNull();
    expect(container.querySelector('.claudemark')).toBeTruthy();
  });
});

describe('ActionButton: la disponibilidad la manda la capacidad', () => {
  it('una acción simulada lleva la marca «sim.» y despacha por el cliente', async () => {
    const { client } = renderWithAde(<ActionButton intent="stop_attempt" args={{ attemptId: 'att_checkout_2' }} />);
    await esperaCapacidades();
    const b = screen.getByRole('button', { name: /Detener/ });
    expect(b.dataset.availability).toBe('simulated');
    expect(within(b).getByLabelText('simulado')).toBeTruthy();
    fireEvent.click(b); // pide confirmación
    fireEvent.click(await screen.findByText(/Confirmar detener/));
    await waitFor(() => expect(screen.getByText(/Simulado: stop_attempt/)).toBeTruthy());
    expect((await client.getAttempt('att_checkout_2')).state).toBe('stopped');
  });

  it('cancelar la confirmación no despacha nada', async () => {
    const { client } = renderWithAde(<ActionButton intent="stop_attempt" args={{ attemptId: 'att_checkout_2' }} />);
    await esperaCapacidades();
    fireEvent.click(screen.getByRole('button', { name: /Detener/ }));
    fireEvent.click(screen.getByText('Cancelar'));
    expect(client.sim.calls).not.toContain('dispatch');
  });

  it('una acción no disponible se ve deshabilitada, con el slice escrito y el motivo, y no despacha', async () => {
    const { client } = renderWithAde(<ActionButton intent="retry_attempt" args={{ attemptId: 'att_webhook_2' }} />);
    await esperaCapacidades();
    const b = screen.getByRole('button', { name: /Reintentar/ });
    expect(b.disabled).toBe(true);
    expect(b.dataset.availability).toBe('unavailable');
    expect(b.textContent).toContain('Task/Attempt');
    expect(b.title).toMatch(/Requiere Task\/Attempt/);
    fireEvent.click(b);
    expect(client.sim.calls).not.toContain('dispatch');
  });

  it('«continuar con otro agente» nombra ContextPackage; registrar proyecto, D', async () => {
    renderWithAde(<><ActionButton intent="continue_with_other_agent" args={{ attemptId: 'x' }} /><ActionButton intent="register_project" args={{ path: '' }} /></>);
    await esperaCapacidades();
    expect(screen.getByRole('button', { name: /Continuar con otro agente/ }).textContent).toContain('ContextPackage');
    expect(screen.getByRole('button', { name: /Registrar proyecto/ }).textContent).toContain('D');
  });

  it('mientras no cargan las capacidades, el botón está deshabilitado (no se asume nada)', () => {
    const client = makeClient({ latencyMs: 50 });
    renderWithAde(<ActionButton intent="stop_attempt" args={{ attemptId: 'x' }} />, { client });
    const b = screen.getByRole('button', { name: /Detener/ });
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Cargando capacidades…');
  });

  it('una acción del cliente (abrir diff) pasa por el host, no por el Core', async () => {
    const host = createRecordingHost();
    const { client } = renderWithAde(<ActionButton intent="open_diff" args={{ attemptId: 'att_pago_1' }} />, { host });
    await waitFor(() => expect(screen.getByRole('button', { name: /Abrir diff/ }).dataset.availability).toBe('available'));
    fireEvent.click(screen.getByRole('button', { name: /Abrir diff/ }));
    await waitFor(() => expect(host.llamadas).toEqual([{ type: 'open_diff', attemptId: 'att_pago_1' }]));
    expect(client.sim.calls).not.toContain('dispatch');
  });

  it('sin puente IDE↔ADE las navegaciones salen como no disponibles con su motivo', async () => {
    renderWithAde(<HostShortcuts attemptId="att_pago_1" />);
    for (const nombre of [/Abrir diff/, /Abrir worktree/, /Abrir en el IDE/, /Ir a la terminal/]) {
      const b = await screen.findByRole('button', { name: nombre });
      expect(b.disabled).toBe(true);
      expect(b.title).toMatch(/puente IDE↔ADE/);
    }
  });

  it('un error del Core se avisa y la acción no queda a medias', async () => {
    const { client } = renderWithAde(<ActionButton intent="stop_attempt" args={{ attemptId: 'att_pago_1' }} confirm={false} />);
    await esperaCapacidades();
    fireEvent.click(screen.getByRole('button', { name: /Detener/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/ya terminó/));
    expect((await client.getAttempt('att_pago_1')).state).toBe('done');
  });
});

async function vistaDe(kind, client = makeClient()) {
  const [items, projects, tasks, attempts] = await Promise.all([client.listAttention(), client.listProjects(), client.listTasks(), client.listAttempts()]);
  return buildAttentionViews(items.filter((i) => i.kind === kind), { projects, tasks, attempts })[0];
}

describe('AttentionCard', () => {
  it('lleva kind, tarea, proyecto, intento, agente y estado', async () => {
    const view = await vistaDe('integrate');
    renderWithAde(<AttentionCard view={view} now={NOW} />);
    const card = screen.getByRole('article');
    expect(card.dataset.kind).toBe('integrate');
    expect(within(card).getByText('Lista para integrar')).toBeTruthy();
    expect(within(card).getByText('Pago con tarjeta 3-D Secure')).toBeTruthy();
    expect(within(card).getByText('orbita-web')).toBeTruthy();
    expect(within(card).getByText('Intento 1')).toBeTruthy();
    expect(within(card).getByText('Terminada')).toBeTruthy();
    expect(within(card).getByText('Revisada y lista para integrar.')).toBeTruthy();
  });

  it('approve_in_terminal: ofrece ir a la terminal (host) y NO un botón de aprobar', async () => {
    renderWithAde(<AttentionCard view={await vistaDe('approve_in_terminal')} now={NOW} />);
    await esperaCapacidades();
    expect(screen.getByRole('button', { name: /Ir a la terminal/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Aprobar/ })).toBeNull();
    expect(screen.getByText(/vence en/)).toBeTruthy();
  });

  it('failed: Reintentar y Continuar con otro agente se muestran no disponibles con su slice; el motivo se explica', async () => {
    renderWithAde(<AttentionCard view={await vistaDe('failed')} now={NOW} />);
    await esperaCapacidades();
    expect(screen.getByText('Nadie aprobó en la terminal a tiempo')).toBeTruthy();
    const r = screen.getByRole('button', { name: /Reintentar/ });
    const c = screen.getByRole('button', { name: /Continuar con otro agente/ });
    expect(r.disabled && c.disabled).toBe(true);
    expect(r.textContent).toContain('Task/Attempt');
    expect(c.textContent).toContain('ContextPackage');
  });

  it('pending_spawn: política efectiva visible y aprobar pide confirmación antes de despachar', async () => {
    const client = makeClient();
    const view = await vistaDe('pending_spawn', client);
    renderWithAde(<AttentionCard view={view} now={NOW} />, { client });
    await esperaCapacidades();
    expect(screen.getByTestId('policy-summary').textContent).toContain(view.attempt.policy.command.join(' '));
    fireEvent.click(screen.getByRole('button', { name: /^Aprobar/ }));
    expect(client.sim.calls).not.toContain('dispatch');
    fireEvent.click(await screen.findByText(/Confirmar aprobar/));
    await waitFor(() => expect(client.sim.calls).toContain('dispatch'));
    await waitFor(async () => expect((await client.getAttempt(view.attempt.id)).state).toBe('starting'));
  });

  it('un lanzamiento elevado muestra el aviso de política elevada', async () => {
    const items = await makeClient().listAttention();
    const client = makeClient();
    const view = buildAttentionViews(items.filter((i) => i.attemptId === 'att_deploy_1'), { attempts: await client.listAttempts(), tasks: await client.listTasks(), projects: await client.listProjects() })[0];
    renderWithAde(<AttentionCard view={view} now={NOW} />);
    expect(screen.getByText('Política elevada')).toBeTruthy();
    expect(screen.getByText(/Sandbox sin restricciones/)).toBeTruthy();
  });

  it('unanswered_question: se responde en línea y la tarjeta desaparece de la bandeja del cliente', async () => {
    const client = makeClient();
    renderWithAde(<AttentionCard view={await vistaDe('unanswered_question', client)} now={NOW} />, { client });
    await esperaCapacidades();
    expect(screen.getByText(/clave de API o por organización/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Responder/ }));
    const campo = screen.getByLabelText('Tu respuesta');
    const enviar = screen.getByRole('button', { name: /Enviar respuesta/ });
    expect(enviar.disabled).toBe(true);
    fireEvent.change(campo, { target: { value: 'Por organización' } });
    fireEvent.click(enviar);
    await waitFor(async () => expect((await client.getAttempt('att_rate_1')).pendingQuestion).toBeNull());
  });

  it('rotula como «reservado» los kinds que G aún no ha decidido', async () => {
    renderWithAde(<AttentionCard view={await vistaDe('pending_spawn')} now={NOW} />);
    expect(screen.getByText('reservado')).toBeTruthy();
    cleanup();
    renderWithAde(<AttentionCard view={await vistaDe('review')} now={NOW} />);
    expect(screen.queryByText('reservado')).toBeNull();
  });

  it('el título enlaza al nivel útil: la revisión para «review», el intento para «failed»', async () => {
    renderWithAde(<AttentionCard view={await vistaDe('review')} now={NOW} />);
    fireEvent.click(screen.getByRole('link', { name: /Internacionalizar|Rotación/ }));
    expect(screen.getByTestId('ruta').textContent).toMatch(/^#\/review\//);
    cleanup();
    renderWithAde(<AttentionCard view={await vistaDe('failed')} now={NOW} />);
    fireEvent.click(screen.getByRole('link', { name: /Reintentos de webhooks/ }));
    expect(screen.getByTestId('ruta').textContent).toBe('#/attempt/att_webhook_2');
  });
});

describe('filas', () => {
  it('TaskRow: estado derivado, último intento, agente y número de intentos', async () => {
    const c = makeClient();
    const task = await c.getTask('tsk_checkout');
    renderWithAde(<TaskRow task={task} attempts={await c.listAttempts({ taskId: task.id })} now={NOW} />);
    const fila = screen.getByTestId('task-tsk_checkout');
    expect(fila.dataset.derived).toBe('in_progress');
    expect(within(fila).getByText('En curso')).toBeTruthy();
    expect(within(fila).getByText('2 intentos')).toBeTruthy();
    expect(within(fila).getByText(/Migrando los campos/)).toBeTruthy();
    fireEvent.click(within(fila).getByRole('link', { name: 'Rediseñar el checkout' }));
    expect(screen.getByTestId('ruta').textContent).toBe('#/task/tsk_checkout');
  });

  it('TaskRow sin intentos no falla', async () => {
    const task = await makeClient().getTask('tsk_idea');
    renderWithAde(<TaskRow task={task} attempts={[]} now={NOW} />);
    expect(screen.getByText('0 intentos')).toBeTruthy();
    expect(screen.getByText('Abierta')).toBeTruthy();
  });

  it('AttemptLine: ordinal, agente, estado y resultado', async () => {
    const a = await makeClient().getAttempt('att_pago_1');
    renderWithAde(<AttemptLine attempt={a} now={NOW} />);
    const l = screen.getByTestId('attempt-att_pago_1');
    expect(l.dataset.state).toBe('done');
    expect(within(l).getByText('Terminada')).toBeTruthy();
    expect(within(l).getByText(/Flujo 3-D Secure/)).toBeTruthy();
  });

  it('ActivityLine: actor con su cliente, verbo y enlace a la entidad', async () => {
    const e = (await makeClient().listActivity()).find((x) => x.type === 'review.completed' && x.actor.client === 'mobile');
    renderWithAde(<ul><ActivityLine entry={e} now={NOW} projectName="sitio-docs" /></ul>);
    expect(screen.getByText('Tú (móvil)')).toBeTruthy();
    expect(screen.getByText(/rechazó la revisión/)).toBeTruthy();
    fireEvent.click(screen.getByRole('link'));
    expect(screen.getByTestId('ruta').textContent).toBe('#/review/att_ref_1');
  });

  it('GroupCounters: solo los grupos con algo; sin nada, lo dice', () => {
    const { container } = renderWithAde(<GroupCounters byGroup={{ active: 2, waiting: 0, needs_person: 1, ok: 0, error: 0, halted: 0 }} />);
    expect([...container.querySelectorAll('.ade-counter')].map((n) => n.dataset.group)).toEqual(['active', 'needs_person']);
    cleanup();
    renderWithAde(<GroupCounters byGroup={{ active: 0, waiting: 0, needs_person: 0, ok: 0, error: 0, halted: 0 }} />);
    expect(screen.getByText('Sin trabajo en curso')).toBeTruthy();
  });

  it('PolicySummary sin elevación no avisa', () => {
    renderWithAde(<PolicySummary policy={{ status: 'ok', command: ['claude'], warnings: [], elevated: false }} />);
    expect(screen.queryByText('Política elevada')).toBeNull();
    expect(screen.getByText('Política verificada')).toBeTruthy();
  });
});

describe('estados vacío / cargando / error y QueryBoundary', () => {
  it('cada estado es reconocible y accesible', () => {
    const onRetry = vi.fn();
    renderWithAde(<><EmptyState title="Nada">Texto</EmptyState><LoadingState label="Cargando cosas" /><ErrorState error={Object.assign(new Error('Falló'), { code: 'unavailable' })} onRetry={onRetry} /></>);
    expect(screen.getByRole('status', { name: 'Cargando cosas' }).getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('[data-ade-state="empty"]').textContent).toContain('Nada');
    expect(screen.getByRole('alert').textContent).toContain('Falló');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalled();
  });

  const base = { data: null, error: null, reload: vi.fn() };
  const montar = (query, props = {}) => renderWithAde(<QueryBoundary query={query} {...props}>{(d) => <i>listo: {d.length}</i>}</QueryBoundary>);

  it('QueryBoundary: cargando mientras no hay datos', () => {
    montar({ ...base, status: 'loading' });
    expect(document.querySelector('[data-ade-state="loading"]')).toBeTruthy();
  });

  it('QueryBoundary: vacío muestra el estado vacío indicado', () => {
    montar({ ...base, status: 'ready', data: [] }, { empty: <b>sin nada</b> });
    expect(screen.getByText('sin nada')).toBeTruthy();
  });

  it('QueryBoundary: error sin datos previos muestra el error con «Reintentar»', () => {
    const reload = vi.fn();
    montar({ ...base, status: 'error', error: new Error('roto'), reload });
    expect(screen.getByRole('alert').textContent).toContain('roto');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(reload).toHaveBeenCalled();
  });

  it('QueryBoundary: si falla la recarga pero hay datos previos, enseña los datos y avisa', () => {
    montar({ ...base, status: 'error', error: new Error('se cayó'), data: [1, 2] });
    expect(screen.getByText('listo: 2')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/últimos datos/);
  });

  it('QueryBoundary: con datos pinta el contenido', () => {
    montar({ ...base, status: 'ready', data: [1, 2, 3] });
    expect(screen.getByText('listo: 3')).toBeTruthy();
  });
});

describe('navegación y piezas pequeñas', () => {
  it('NavLink es un enlace real (copiable) que navega sin recargar', () => {
    renderWithAde(<NavLink route={routes.attempt('att_x')}>Ir</NavLink>);
    const a = screen.getByRole('link', { name: 'Ir' });
    expect(a.getAttribute('href')).toBe('#/attempt/att_x');
    fireEvent.click(a);
    expect(screen.getByTestId('ruta').textContent).toBe('#/attempt/att_x');
  });

  it('Breadcrumbs: todos enlazan salvo el último', () => {
    renderWithAde(<Breadcrumbs trail={[{ label: 'Inicio', route: routes.home() }, { label: 'Proyecto', route: routes.project('p') }, { label: 'Aquí', route: routes.task('t') }]} />);
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Inicio', 'Proyecto']);
    expect(screen.getByText('Aquí').getAttribute('aria-current')).toBe('page');
  });

  it('SimBadge dice que es simulado', () => {
    renderWithAde(<SimBadge />);
    expect(screen.getByText('Simulado').title).toMatch(/no tocan el Core/);
  });
});
