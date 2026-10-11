import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WorktreeEnv } from './WorktreeEnv';

afterEach(cleanup);

describe('WorktreeEnv', () => {
  it('antes de aprobar usa futuro y avisa de que lo copiado puede traer secretos', () => {
    render(<WorktreeEnv env={{ shared: ['node_modules'], copy: ['.env'], skipped: [] }} />);
    expect(screen.getByTestId('worktree-env-shared').textContent).toContain('Se enlazará');
    expect(screen.getByTestId('worktree-env-copy').textContent).toMatch(/Se copiará.*secretos.*\.env/);
    expect(screen.queryByTestId('worktree-env-skipped')).toBeNull();
  });

  it('después de crear usa pasado y lista lo omitido con su motivo', () => {
    render(<WorktreeEnv done env={{ shared: [], copy: ['.env'], skipped: [{ path: 'src', reason: 'está versionado' }] }} />);
    expect(screen.getByTestId('worktree-env-copy').textContent).toContain('Copiado');
    expect(screen.queryByTestId('worktree-env-shared')).toBeNull();
    expect(screen.getByTestId('worktree-env-skipped').textContent).toBe('Omitido: src (está versionado)');
  });

  it.each([undefined, null, {}, { shared: [], copy: [], skipped: [] }])('sin nada que contar (%j) no pinta nada', (env) => {
    const { container } = render(<WorktreeEnv env={env} />);
    expect(container.firstChild).toBeNull();
  });
});
