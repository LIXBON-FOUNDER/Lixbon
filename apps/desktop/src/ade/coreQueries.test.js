import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTENTION_LIMIT, TASK_PAGE_LIMIT, listAdeTasks, queryAdeCore } from './coreQueries';

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

  it('listAdeTasks exige un Project durable y usa active por defecto', async () => {
    invoke.mockResolvedValue({
      v: 1,
      project_id: 'project-1',
      filters: { status: 'active' },
      limit: TASK_PAGE_LIMIT,
      tasks: [],
      has_more: false,
      next_cursor: null,
    });

    await listAdeTasks('project-1');
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'active', limit: TASK_PAGE_LIMIT },
    });

    await expect(listAdeTasks('')).rejects.toThrow('ade_query_invalid_request');
  });

  it('transporta target_kind y target_id juntos, valida el tipo y exige que la página corresponda al target', async () => {
    const row = {
      id: 'att_1', category: 'question', severity: 'high', status: 'active', target_kind: 'task',
      target_id: 'task-1', project_id: 'project-1', run_id: null, occurrence: 1, created_at: 1,
      resolved_at: null, resolution: null,
    };
    const response = { v: 1, items: [row], next_cursor: 'cursor-1', has_more: true, limit: ATTENTION_LIMIT };
    invoke.mockResolvedValue(response);

    await queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT, target_kind: 'task', target_id: 'task-1' },
    });

    await queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1', category: 'question', cursor: 'cursor-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT, target_kind: 'task', target_id: 'task-1', category: 'question', cursor: 'cursor-1' },
    });

    invoke.mockClear();
    await expect(queryAdeCore('attention_list', { targetKind: 'task' })).rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { targetKind: 'attention', targetId: 'x' })).rejects.toThrow('ade_query_invalid_request');
    expect(invoke).not.toHaveBeenCalled();

    // No se recorta una página ajena en cliente: se rechaza entera.
    invoke.mockResolvedValue({ ...response, items: [row, { ...row, id: 'att_2', target_id: 'task-2' }] });
    await expect(queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_response');
    invoke.mockResolvedValue({ ...response, items: [{ ...row, target_kind: 'run' }] });
    await expect(queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_response');
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

  it('transporta tasks_by_project con los tres status del contrato, limit fijo y cursor opaco', async () => {
    const task = {
      id: 'task-1', run_id: 'run-1', parent_id: null, root_id: 'task-1', status: 'running',
      title: 'Implementar X', provider: 'claude', model: null, created_at: 1_000, updated_at: 2_000,
    };
    const page = (status) => ({
      v: 1,
      project_id: 'project-1',
      filters: { status },
      limit: TASK_PAGE_LIMIT,
      tasks: [task],
      has_more: false,
      next_cursor: null,
    });

    invoke.mockResolvedValue(page('active'));
    // `limit` no se acepta desde el llamador: la página fija es la del contrato y el cursor depende de ella.
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', limit: 100 });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'active', limit: TASK_PAGE_LIMIT },
    });

    invoke.mockResolvedValue(page('final'));
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'final', limit: TASK_PAGE_LIMIT },
    });

    invoke.mockResolvedValue(page('all'));
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'all', cursor: 'cursor-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'all', limit: TASK_PAGE_LIMIT, cursor: 'cursor-1' },
    });

    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'done' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'todo' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: '  ' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', cursor: 7 }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', cursor: '   ' }))
      .rejects.toThrow('ade_query_invalid_request');
  });

  it('exige el eco exacto de project_id, status y limit, y rechaza Tasks incompletas', async () => {
    const task = {
      id: 'task-1', run_id: 'run-1', parent_id: null, root_id: 'task-1', status: 'failed',
      title: 'Implementar X', provider: null, model: null, created_at: 1_000, updated_at: 2_000,
    };
    const valid = {
      v: 1,
      project_id: 'project-1',
      filters: { status: 'final' },
      limit: TASK_PAGE_LIMIT,
      tasks: [task],
      has_more: true,
      next_cursor: 'cursor-1',
    };

    invoke.mockResolvedValue({ ...valid, project_id: 'project-2' });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, filters: { status: 'active' } });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, limit: 100 });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, tasks: [{ ...task, created_at: 'ayer' }] });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(valid);
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .resolves.toEqual(valid);
  });
});
