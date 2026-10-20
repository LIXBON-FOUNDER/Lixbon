import { useState } from 'react';
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
    expect(within(screen.getByRole('group', { name: 'Projects' })).getAllByRole('option')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Attention' })).getAllByRole('option')).toHaveLength(1);

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

  it('rejects a stale active result when updated props replace it', () => {
    const onNavigate = vi.fn();
    const task = { id: 'task-stale', projectId: 'project-1', title: 'Stale Task' };
    const { rerender } = render(<Harness tasks={[task]} onNavigate={onNavigate} />);
    const input = screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
    expect(activeOption(input).textContent).toContain('Stale Task');

    rerender(<Harness tasks={[{ id: 'task-current', projectId: 'project-1', title: 'Replacement Task' }]} onNavigate={onNavigate} />);
    expect(screen.getByRole('option', { name: /Replacement Task/ })).toBeTruthy();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input).textContent).toContain('Replacement Task');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', projectId: 'project-1', taskId: 'task-current' });
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
