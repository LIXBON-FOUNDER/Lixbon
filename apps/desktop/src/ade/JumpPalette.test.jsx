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
        attention={[{ projectId: 'project-c', taskId: 'task-c', title: 'Review diff' }]}
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

  it('keeps 125 Tasks available and supports arrow, Home, End, and Enter navigation', () => {
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

    fireEvent.keyDown(input, { key: 'End' });
    expect(activeOption(input).textContent).toContain('Task 125');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input).textContent).toContain('Task 124');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeOption(input).textContent).toContain('Task 1');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input).textContent).toContain('Task 2');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-2' });
  });

  it('activates on row entry and ignores repeated movement within one of 125 results', () => {
    let commits = 0;
    const tasks = Array.from({ length: 125 }, (_, index) => ({
      id: `task-${index + 1}`,
      projectId: 'project-1',
      title: `Task ${index + 1}`,
    }));
    render(
      <Profiler id="jump-palette" onRender={() => { commits += 1; }}>
        <Harness tasks={tasks} />
      </Profiler>,
    );

    const option = screen.getByText('Task 2').closest('[role="option"]');
    expect(option).not.toBeNull();
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    const commitsBeforePointer = commits;
    fireEvent.mouseEnter(option);
    expect(activeOption(input)).toBe(option);
    expect(commits - commitsBeforePointer).toBe(1);
    for (let index = 0; index < 50; index += 1) fireEvent.mouseMove(option);
    expect(commits - commitsBeforePointer).toBe(1);
  });

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
        attention={[{ projectId: 'project-3', taskId: 'task-3', title: 'Review this diff' }]}
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
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'attention', projectId: 'project-3', taskId: 'task-3' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const reopenedInput = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    fireEvent.keyDown(reopenedInput, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
