import { Profiler, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { JumpPalette } from './JumpPalette';

function Harness({ initialOpen = true, onNavigate = vi.fn(), onClose = vi.fn(), ...results }) {
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState('');
  const close = () => {
    onClose();
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open Jump Palette</button>
      <JumpPalette
        open={open}
        query={query}
        onQueryChange={setQuery}
        loading={results.loading}
        projects={results.projects}
        tasks={results.tasks}
        attention={results.attention}
        onNavigate={onNavigate}
        onClose={close}
      />
    </>
  );
}

function activeOption(input) {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

afterEach(cleanup);

describe('JumpPalette', () => {
  it('groups normalized results and searches names, titles, durable IDs, and branches by substring', () => {
    const onNavigate = vi.fn();
    render(
      <Harness
        onNavigate={onNavigate}
        projects={[{ id: 'project-a', name: 'Workspace Alpha' }]}
        tasks={[{ id: 'task-a', projectId: 'project-b', title: 'Ship auth', branch: 'feat/auth-flow' }]}
        attention={[{ id: 'att-c', projectId: 'project-c', targetKind: 'task', targetId: 'task-c', title: 'Review diff' }]}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(document.activeElement).toBe(input);
    const listbox = screen.getByRole('listbox', { name: 'Resultados de navegación' });
    expect(within(screen.getByRole('group', { name: 'Projects' })).getAllByRole('option')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Attention' })).getAllByRole('option')).toHaveLength(1);
    expect(Array.from(listbox.children).every((child) => child.getAttribute('role') === 'group')).toBe(true);
    for (const group of listbox.children) {
      expect(group.getAttribute('aria-label')).toBeTruthy();
      expect(Array.from(group.children)
        .filter((child) => child.getAttribute('aria-hidden') !== 'true')
        .every((child) => child.getAttribute('role') === 'option')).toBe(true);
    }
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(listbox.contains(screen.getByRole('status'))).toBe(false);

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(activeOption(input).getAttribute('aria-selected')).toBe('true');
    fireEvent.change(input, { target: { value: 'Ship' } });
    expect(screen.getByRole('option', { name: /Ship auth/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'task-a' } });
    expect(screen.getByRole('option', { name: /Ship auth/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'feat/auth' } });
    expect(screen.getByRole('option', { name: /Ship auth/ })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Projects' })).toBeNull();
    fireEvent.change(input, { target: { value: 'shp auth' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('Sin resultados');
    expect(listbox.contains(screen.getByRole('status'))).toBe(false);

    fireEvent.change(input, { target: { value: 'project-a' } });
    const project = screen.getByRole('option', { name: /Workspace Alpha/ });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'project', projectId: 'project-a' });
    expect(project.textContent).toContain('project-a');
  });

  it('keeps 125 Tasks available and supports arrows, Ctrl+Home/Ctrl+End, and Enter navigation', { timeout: 20_000 }, () => {
    const onNavigate = vi.fn();
    const tasks = Array.from({ length: 125 }, (_, index) => ({
      id: `task-${index + 1}`,
      projectId: 'project-1',
      title: `Task ${index + 1}`,
      branch: `branch-${index + 1}`,
    }));
    render(<Harness tasks={tasks} onNavigate={onNavigate} />);

    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(screen.getAllByRole('option')).toHaveLength(125);

    fireEvent.keyDown(input, { key: 'End', ctrlKey: true });
    expect(activeOption(input).textContent).toContain('Task 125');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input).textContent).toContain('Task 124');
    fireEvent.keyDown(input, { key: 'Home', ctrlKey: true });
    expect(activeOption(input).textContent).toContain('Task 1');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input).textContent).toContain('Task 2');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-2' });
  });

  it('keeps keyboard selection independent of pointer hover across 125 results while clicks navigate', { timeout: 20_000 }, () => {
    let commits = 0;
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const tasks = Array.from({ length: 125 }, (_, index) => ({
      id: `task-${index + 1}`,
      projectId: 'project-1',
      title: `Task ${index + 1}`,
    }));
    render(
      <Profiler id="jump-palette" onRender={() => { commits += 1; }}>
        <Harness tasks={tasks} onNavigate={onNavigate} onClose={onClose} />
      </Profiler>,
    );

    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    const first = screen.getByText('Task 1').closest('[role="option"]');
    const second = screen.getByText('Task 2').closest('[role="option"]');
    const third = screen.getByText('Task 3').closest('[role="option"]');
    const commitsBeforePointer = commits;

    expect(screen.getAllByRole('option')).toHaveLength(125);
    fireEvent.mouseEnter(second);
    fireEvent.mouseMove(third);
    expect(activeOption(input)).toBe(first);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    expect(third.getAttribute('aria-selected')).toBe('false');
    expect(screen.getAllByRole('option')).toHaveLength(125);
    expect(commits - commitsBeforePointer).toBe(0);

    fireEvent.keyDown(input, { key: 'End', ctrlKey: true });
    expect(activeOption(input).textContent).toContain('Task 125');
    expect(commits - commitsBeforePointer).toBe(1);

    fireEvent.keyDown(input, { key: 'Home', ctrlKey: true });
    expect(activeOption(input)).toBe(first);
    expect(commits - commitsBeforePointer).toBe(2);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toBe(second);
    expect(commits - commitsBeforePointer).toBe(3);

    fireEvent.mouseEnter(third);
    fireEvent.mouseMove(third);
    expect(activeOption(input)).toBe(second);
    expect(commits - commitsBeforePointer).toBe(3);

    fireEvent.click(third);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-3' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves Home and End available to move the text cursor in the search input', () => {
    render(<Harness tasks={Array.from({ length: 3 }, (_, index) => ({
      id: `task-${index + 1}`, projectId: 'project-1', title: `Task ${index + 1}`,
    }))} />);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    fireEvent.change(input, { target: { value: 'Task' } });
    input.setSelectionRange(2, 2);
    const selected = activeOption(input);

    const home = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    fireEvent(input, home);
    const end = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    fireEvent(input, end);

    expect(home.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(activeOption(input)).toBe(selected);
  });

  it.each(['Quick Open (Ctrl+P)', 'Command Palette (Ctrl+Shift+P)'])(
    'does not steal focus from %s when the palette closes externally',
    (surfaceName) => {
      const onClose = vi.fn();
      const view = (open) => (
        <>
          <button type="button">Previous surface</button>
          <input type="text" aria-label={surfaceName} />
          <JumpPalette open={open} query="" onQueryChange={vi.fn()} onClose={onClose} />
        </>
      );
      const { rerender } = render(view(false));
      const previous = screen.getByRole('button', { name: 'Previous surface' });
      previous.focus();
      rerender(view(true));
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' }));

      const competingSurface = screen.getByRole('textbox', { name: surfaceName });
      competingSurface.focus();
      rerender(view(false));

      expect(document.activeElement).toBe(competingSurface);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each(['inert', 'hidden', 'aria-hidden', 'unmounted'])(
    'does not restore focus to a previous surface that became %s',
    (surfaceState) => {
      const onClose = vi.fn();
      const view = (open, blocked = false) => (
        <>
          {surfaceState === 'unmounted' && blocked ? null : (
            <div
              inert={surfaceState === 'inert' && blocked ? true : undefined}
              hidden={surfaceState === 'hidden' && blocked}
              aria-hidden={surfaceState === 'aria-hidden' && blocked ? 'true' : undefined}
            >
              <button type="button">Previous surface</button>
            </div>
          )}
          <JumpPalette open={open} query="" onQueryChange={vi.fn()} onClose={onClose} />
        </>
      );
      const { rerender } = render(view(false));
      const previous = screen.getByRole('button', { name: 'Previous surface' });
      previous.focus();
      rerender(view(true));
      const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
      fireEvent.keyDown(input, { key: 'Escape' });
      rerender(view(false, true));

      expect(document.activeElement).not.toBe(previous);
      if (surfaceState === 'unmounted') expect(previous.isConnected).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('rebases the active key to async replacements without navigating a stale result', () => {
    const onNavigate = vi.fn();
    const task = { id: 'task-stale', projectId: 'project-1', title: 'Stale Task' };
    const { rerender } = render(<Harness tasks={[task]} onNavigate={onNavigate} />);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(activeOption(input).textContent).toContain('Stale Task');

    rerender(<Harness tasks={[{ id: 'task-current', projectId: 'project-1', title: 'Replacement Task' }]} onNavigate={onNavigate} />);
    const replacement = screen.getByRole('option', { name: /Replacement Task/ });
    expect(activeOption(input)).toBe(replacement);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-current' });
    expect(onNavigate).not.toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-stale' });
  });

  it('announces loading once outside the listbox without exposing stale options', () => {
    const onNavigate = vi.fn();
    render(
      <Harness
        loading
        onNavigate={onNavigate}
        tasks={[{ id: 'task-stale', projectId: 'project-1', title: 'Stale Task' }]}
      />,
    );

    const listbox = screen.getByRole('listbox', { name: 'Resultados de navegación' });
    const status = screen.getByRole('status');
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(listbox.getAttribute('aria-busy')).toBe('true');
    expect(listbox.children).toHaveLength(0);
    expect(screen.queryByRole('option')).toBeNull();
    expect(status.textContent).toContain('Cargando resultados');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(listbox.contains(status)).toBe(false);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('keeps Escape and Tab handling after pointer clicks on non-interactive header and status text', () => {
    render(<Harness tasks={[{ id: 'task-1', projectId: 'project-1', title: 'Task One' }]} />);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    const closeButton = screen.getByRole('button', { name: 'Cerrar Jump Palette' });

    fireEvent.mouseDown(screen.getByRole('heading', { name: 'Jump Palette' }));
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.mouseDown(screen.getByRole('status'));
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.mouseDown(screen.getByRole('heading', { name: 'Jump Palette' }));
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navigates Attention by durable IDs and restores focus when Escape closes the palette', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(
      <Harness
        initialOpen={false}
        onNavigate={onNavigate}
        onClose={onClose}
        attention={[{ id: 'att-3', projectId: 'project-3', targetKind: 'task', targetId: 'task-3', title: 'Review this diff' }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Open Jump Palette' });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(document.activeElement).toBe(input);
    const closeButton = screen.getByRole('button', { name: 'Cerrar Jump Palette' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole('option', { name: /Review this diff/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'attention', attentionId: 'att-3', targetKind: 'task', targetId: 'task-3', projectId: 'project-3' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const reopenedInput = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    fireEvent.keyDown(reopenedInput, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('keeps the palette open when onNavigate rejects, announces the notice, and reaches its action with Tab', () => {
    const onNavigate = vi.fn(() => false);
    const onClose = vi.fn();
    const onAction = vi.fn();
    render(
      <JumpPalette
        open
        query=""
        onQueryChange={vi.fn()}
        tasks={[{ id: 'task-1', projectId: 'project-1', title: 'Task One' }]}
        onNavigate={onNavigate}
        onClose={onClose}
        notice={{ message: 'La Task task-1 ya no está en Core.', actionLabel: 'Actualizar resultados', onAction }}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(screen.getByRole('alert').textContent).toContain('La Task task-1 ya no está');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    const action = screen.getByRole('button', { name: 'Actualizar resultados' });
    const closeButton = screen.getByRole('button', { name: 'Cerrar Jump Palette' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(document.activeElement).toBe(action);
    fireEvent.keyDown(action, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  it('shows display-only facts without searching them and appends the status note', () => {
    render(
      <Harness
        projects={[{ id: 'project-a', name: 'Alpha', facts: ['Estado active', 'Host/origen no informado'] }]}
        tasks={[{ id: 'task-a', projectId: 'project-a', title: 'Ship', facts: ['Estado running'] }]}
      />,
    );
    expect(screen.getByRole('option', { name: /Alpha/ }).textContent).toContain('Host/origen no informado');
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    fireEvent.change(input, { target: { value: 'running' } });
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('exposes the exact Attention target (id, kind, target id, project) and keeps focus while results change in the background', () => {
    const onNavigate = vi.fn();
    const attention = [{ id: 'att-9', projectId: '', targetKind: 'spawn_request', targetId: 'pend-1', title: 'Approve spawn' }];
    const { rerender } = render(<Harness attention={attention} onNavigate={onNavigate} />);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(document.activeElement).toBe(input);

    rerender(<Harness attention={[...attention, { id: 'att-10', targetKind: 'task', targetId: 't', projectId: 'p', title: 'Other' }]} onNavigate={onNavigate} />);
    expect(document.activeElement).toBe(input);
    expect(activeOption(input).textContent).toContain('Approve spawn');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'attention', attentionId: 'att-9', targetKind: 'spawn_request', targetId: 'pend-1', projectId: null });
  });
});

describe('JumpPalette · recientes', () => {
  const projects = [{ id: 'p-1', name: 'Alpha' }, { id: 'p-2', name: 'Beta' }];
  const tasks = [{ id: 't-1', projectId: 'p-1', title: 'Primera' }, { id: 't-2', projectId: 'p-1', title: 'Segunda' }];
  const recents = [
    { kind: 'task', projectId: 'p-1', taskId: 't-2' },
    { kind: 'task', projectId: 'p-9', taskId: 't-2' }, // obsoleto: no está en los resultados
    { kind: 'project', projectId: 'p-2' },
    { kind: 'task', projectId: 'p-1', taskId: 't-2' }, // repetido
  ];
  const renderPalette = (query = '', onNavigate = vi.fn()) => render(
    <JumpPalette open query={query} onQueryChange={vi.fn()} projects={projects} tasks={tasks} recents={recents} onNavigate={onNavigate} onClose={vi.fn()} />,
  );

  it('sin búsqueda muestra primero los que siguen existiendo, en orden y sin repetirlos en sus grupos', () => {
    const onNavigate = vi.fn();
    renderPalette('', onNavigate);

    const groupNames = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'));
    expect(groupNames).toEqual(['Recientes', 'Projects', 'Tasks']);
    const recent = within(screen.getByRole('group', { name: 'Recientes' })).getAllByRole('option');
    expect(recent.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Segunda'),
      expect.stringContaining('Beta'),
    ]);
    expect(within(screen.getByRole('group', { name: 'Projects' })).getAllByRole('option')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(1);

    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(activeOption(input)).toBe(recent[0]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'p-1', taskId: 't-2' });
  });

  it('con una búsqueda vuelve a los grupos normales', () => {
    renderPalette('Segunda');
    expect(screen.queryByRole('group', { name: 'Recientes' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(1);
  });
});
