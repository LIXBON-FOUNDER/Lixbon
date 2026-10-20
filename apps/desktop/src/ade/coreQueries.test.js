import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { queryAdeCore } from './coreQueries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => invoke.mockReset());

describe('queryAdeCore', () => {
  it('solo transporta las tres queries observacionales permitidas', async () => {
    invoke.mockResolvedValue({
      v: 1,
      filters: { archived: 'exclude', machine: null },
      total: 0,
      projects: [],
      unassigned: {},
    });

    await queryAdeCore('projects_overview');

    expect(invoke).toHaveBeenCalledWith('orch_query', {
      query: 'projects_overview',
      args: { archived: 'exclude' },
    });
    await expect(queryAdeCore('project_archive')).rejects.toThrow('ade_query_forbidden');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rechaza páginas incompatibles con la versión y el contrato del Core', async () => {
    invoke.mockResolvedValue({
      v: 2,
      project_id: 'project-1',
      filters: { status: 'active' },
      limit: 50,
      tasks: [],
      has_more: true,
      next_cursor: null,
    });

    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');
  });
});
