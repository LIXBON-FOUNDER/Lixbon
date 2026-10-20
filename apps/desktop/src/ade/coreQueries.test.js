import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTENTION_LIMIT, queryAdeCore } from './coreQueries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => invoke.mockReset());

describe('queryAdeCore', () => {
  it('solo transporta las queries observacionales permitidas', async () => {
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
    await expect(queryAdeCore('attention_detail', { attentionId: 'att_1' })).rejects.toThrow('ade_query_forbidden');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('pide projects_overview con archived del contrato y exige el eco exacto', async () => {
    invoke.mockResolvedValueOnce({
      v: 1,
      filters: { archived: 'include', machine: null },
      total: 1,
      projects: [{ id: 'project-1', name: 'Uno' }],
      unassigned: {},
    });

    await queryAdeCore('projects_overview', { archived: 'include' });

    expect(invoke).toHaveBeenCalledWith('orch_query', {
      query: 'projects_overview',
      args: { archived: 'include' },
    });

    await expect(queryAdeCore('projects_overview', { archived: 'todo' }))
      .rejects.toThrow('ade_query_invalid_request');

    invoke.mockResolvedValueOnce({
      v: 1,
      filters: { archived: 'exclude', machine: null },
      total: 0,
      projects: [],
      unassigned: {},
    });
    await expect(queryAdeCore('projects_overview', { archived: 'include' }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('transporta attention_list con limit fijo, filtros del contrato y cursor opaco', async () => {
    const attentionItem = {
      id: 'att_1',
      category: 'question',
      severity: 'high',
      status: 'active',
      target_kind: 'task',
      target_id: 'task-1',
      project_id: 'project-1',
      run_id: null,
      occurrence: 1,
      created_at: 1_000,
      resolved_at: null,
      resolution: null,
    };
    invoke.mockResolvedValue({
      v: 1,
      items: [attentionItem],
      next_cursor: 'cursor-1',
      has_more: true,
      limit: ATTENTION_LIMIT,
    });

    await queryAdeCore('attention_list');
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT },
    });

    await queryAdeCore('attention_list', {
      projectId: 'project-1',
      category: 'review_ready',
      severity: 'critical',
      cursor: 'cursor-1',
    });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: {
        limit: ATTENTION_LIMIT,
        project_id: 'project-1',
        category: 'review_ready',
        severity: 'critical',
        cursor: 'cursor-1',
      },
    });

    await expect(queryAdeCore('attention_list', { category: 'unknown' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { severity: 'urgent' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { cursor: '' }))
      .resolves.toBeTruthy();
  });

  it('rechaza páginas de Attention que no cumplen el contrato de LXO-89', async () => {
    const valid = {
      v: 1,
      items: [{
        id: 'att_1', category: 'risk', severity: 'high', status: 'active', target_kind: 'task',
        target_id: 'task-1', project_id: null, run_id: null, occurrence: 1, created_at: 1,
        resolved_at: null, resolution: null,
      }],
      next_cursor: null,
      has_more: false,
      limit: ATTENTION_LIMIT,
    };

    invoke.mockResolvedValue({ ...valid, v: 2 });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, has_more: true, next_cursor: null });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, limit: 500 });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...valid,
      items: [{ ...valid.items[0], category: 'unknown' }],
    });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, items: [{ ...valid.items[0], status: 'resolved' }] });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(valid);
    await expect(queryAdeCore('attention_list')).resolves.toEqual(valid);
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
