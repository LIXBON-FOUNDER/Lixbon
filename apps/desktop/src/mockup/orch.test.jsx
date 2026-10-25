// orch.test.jsx — Pruebas del Orquestador del Desktop (maqueta). El «Core» es orchStore: todo es setState + setTimeout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import React from 'react';
import OrchDesktop from './orch/OrchDesktop';
import { useOrch, attentionItems, canIntegrate, validateRole, fleetCounts } from './orch/orchStore';
import { TASKS } from './orch/orchData';

const st = () => useOrch.getState();

beforeEach(() => { vi.useFakeTimers(); st().reset(); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('reglas del Orquestador', () => {
  it('Integrar exige revisión aceptada sobre el HEAD actual', () => {
    const t5 = () => st().tasks.find((t) => t.id === 't5');
    expect(canIntegrate(st(), t5())).toBe(false);
    st().review('t5', 'accepted');
    expect(canIntegrate(st(), t5())).toBe(true);
    st().patch('t5', { head: 'ffffff0' }); // la rama recibe otro commit
    expect(canIntegrate(st(), t5())).toBe(false);
  });

  it('un rol de solo lectura no se asigna a un agente sin modo verificado (falla cerrado)', () => {
    expect(validateRole('revisor', { agent: 'copilot' })).toMatch(/solo lectura/);
    expect(validateRole('revisor', { agent: 'cursor' })).toMatch(/pausado/);
    expect(validateRole('implementador', { agent: 'copilot' })).toBeNull();
    expect(st().setRole('revisor', { agent: 'copilot' })).toBe(false);
    expect(st().roles.revisor.agent).toBe('codex');
  });

  it('las decisiones pendientes salen ordenadas: aprobar, lanzamientos, preguntas, integrar/revisar, fallos', () => {
    const kinds = attentionItems(st()).map((i) => i.kind);
    expect(kinds.indexOf('approve')).toBe(0);
    expect(kinds.filter((k) => k === 'spawn')).toHaveLength(2);
    expect(kinds).toContain('question');
    expect(kinds).toContain('review');
    expect(kinds.indexOf('failed')).toBeGreaterThan(kinds.indexOf('review'));
  });

  it('los totales salen de las filas: coste del run = suma de tareas', () => {
    const sum = TASKS.reduce((n, t) => n + t.cost, 0);
    expect(fleetCounts(st()).cost).toBeCloseTo(sum, 5);
  });

  it('terminar t3 desbloquea t4 (dependencia --after)', () => {
    expect(st().tasks.find((t) => t.id === 't4').status).toBe('blocked');
    st().simulate('t3-done');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(st().tasks.find((t) => t.id === 't4').status).toBe('running');
  });
});

describe('pantalla del Orquestador', () => {
  it('abre en el run y dice qué espera al usuario', () => {
    render(<OrchDesktop />);
    expect(screen.getByRole('heading', { level: 1, name: /Cerrar los pendientes del corte/i })).toBeDefined();
    expect(screen.getByText(/1 aprobación en terminal/)).toBeDefined();
    expect(screen.getByLabelText('Estado del run')).toBeDefined();
  });

  it('abre una hija desde el árbol y muestra su agente, modelo y rama', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getAllByText('Navegación F2 por Attempt')[0].closest('button'));
    expect(screen.getByRole('heading', { level: 1, name: 'Navegación F2 por Attempt' })).toBeDefined();
    expect(screen.getByText('lx/nav-f2-attempt')).toBeDefined();
    expect(screen.getByRole('tab', { name: /Terminal/ })).toBeDefined();
  });

  it('aprobar en la terminal reanuda la tarea', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getAllByText('Aviso de corte en el ADE')[0].closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(st().tasks.find((t) => t.id === 't3').status).toBe('running');
  });

  it('el flujo Revisar → Aceptar → Integrar pasa por confirmaciones explícitas', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getAllByText('Rechazo en solo lectura')[0].closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar diff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar este diff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Integrar' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Integrar' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(confirm);
    expect(st().integrated.t5).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('un lanzamiento pendiente no arranca hasta confirmar la política', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getByText('Pruebas de migración 900').closest('button'));
    const approve = screen.getByRole('button', { name: 'Aprobar y lanzar' });
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(approve);
    expect(st().pending.find((p) => p.id === 'p2')).toBeUndefined();
    expect(st().tasks.some((t) => t.title === 'Pruebas de migración 900')).toBe(true);
  });

  it('detener pide confirmación y avisa al coordinador', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getAllByText('Navegación F2 por Attempt')[0].closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));
    fireEvent.click(screen.getByRole('button', { name: 'Detener tarea' }));
    expect(st().tasks.find((t) => t.id === 't2').status).toBe('stopped');
    expect(st().messages.some((m) => m.from === 't2' && m.kind === 'exited')).toBe(true);
  });

  it('Flota y Equipo se abren desde la barra', () => {
    render(<OrchDesktop />);
    fireEvent.click(screen.getByRole('tab', { name: 'Flota' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Flota' })).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Equipo' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Equipo' })).toBeDefined();
    expect(screen.getByLabelText('Agente de revisor')).toBeDefined();
  });
});
