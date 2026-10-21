import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import {
  ResourcesInventory,
  readInventory,
  scopeByProject,
  sectionOf,
  matchesState,
  matchesReview,
  isMissing,
} from './ResourcesInventory';

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: el DTO de Core de `resource_inventory` (docs/core/RESOURCES.md) tal cual.
// No hay un modelo alterno: los mismos campos, los mismos valores y los mismos vocabularios
// que documenta el Core (`worktrees[].state`, `dirty`/`merged` con `skipped`, `needs_review`,
// `warnings.branches_to_review`, repos con `scan: ok|unavailable|other_machine`).
const target = (over = {}) => ({ machine: 'm-1', project_id: 'p-1', repo: '/home/ana/app', path: '/home/ana/app.lixbon-wt/wt', ...over });

const DTO = {
  v: 1,
  machine: 'm-1',
  filters: { project_id: null, probe: true },
  repos: [
    { project_id: 'p-1', machine: 'm-1', path: '/home/ana/app', scan: 'ok' },
    { project_id: 'p-2', machine: 'm-1', path: '/home/ana/roto', scan: 'unavailable', reason: 'not_a_repository' },
    { project_id: 'p-3', machine: 'otro-equipo', path: '/srv/remoto', scan: 'other_machine', reason: 'other_machine' },
  ],
  worktrees: [
    {
      target: target({ path: '/home/ana/app.lixbon-wt/wt-c' }),
      state: 'tracked', origin: 'task', physical: 'present',
      git: { registered: true, branch: 'lx/r/c', detached: false, locked: false, prunable: false },
      owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
      dirty: 'clean', merged: 'unmerged', into: 'main', needs_review: true,
    },
    {
      // Falta en disco y git no pudo preguntar: sigue siendo «falta» (lo afirma el disco).
      target: target({ path: '/home/ana/app.lixbon-wt/wt-falta' }),
      state: 'missing_on_disk', origin: 'task', physical: 'missing',
      git: { registered: null, branch: 'lx/r/f', detached: false, locked: false, prunable: true },
      owner: { task_id: 't-10', run_id: 'r-2', status: 'done' },
      dirty: 'skipped', merged: 'skipped', into: 'main', needs_review: false,
    },
    {
      target: target({ path: '/home/ana/app.lixbon-wt/wt-no-reg' }),
      state: 'not_registered', origin: 'task', physical: 'present',
      git: { registered: false, branch: 'lx/r/n', detached: false, locked: false, prunable: false },
      owner: { task_id: 't-11', run_id: 'r-2', status: 'done' },
      dirty: 'skipped', merged: 'unknown', into: 'main', needs_review: false,
    },
    {
      // Huérfano: sin dueño y nunca cuenta como «rama por revisar».
      target: target({ path: '/home/ana/app.lixbon-wt/wt-huerfano' }),
      state: 'orphan_candidate', origin: 'lixbon_dir', physical: 'present',
      git: { registered: true, branch: 'lx/r/h', detached: false, locked: false, prunable: false },
      owner: null,
      dirty: 'dirty', merged: 'unmerged', into: 'main', needs_review: false,
    },
    {
      target: target({ path: '/otro/wt' }),
      state: 'external', origin: 'external', physical: 'present',
      git: { registered: true, branch: 'otra/rama', detached: false, locked: false, prunable: false },
      owner: null,
      dirty: 'clean', merged: 'unknown', into: 'main', needs_review: false,
    },
    {
      // Git caído: `unknown`, nunca «falta».
      target: target({ path: '/home/ana/app.lixbon-wt/wt-desconocido' }),
      state: 'unknown', origin: 'task', physical: 'unknown',
      git: { registered: null, branch: null, detached: false, locked: false, prunable: false },
      owner: { task_id: 't-12', run_id: 'r-3', status: 'running' },
      dirty: 'unknown', merged: 'unknown', into: null, needs_review: null,
    },
  ],
  preserved_branches: [
    {
      target: { machine: 'm-1', project_id: 'p-1', repo: '/home/ana/app', branch: 'lx/r/g' },
      branch_exists: true,
      owner: { task_id: 't-4', run_id: 'r-1', status: 'stopped' },
      merged: 'unmerged', into: 'main', needs_review: true,
    },
  ],
  warnings: {
    branches_to_review: 2,
    worktrees_by_state: { tracked: 1, missing_on_disk: 1, not_registered: 1, orphan_candidate: 1, external: 1, unknown: 1 },
  },
};

const rowsIn = (section) => within(screen.getByTestId(`resinv-section-${section}`)).queryAllByTestId('resinv-row');
const targetsIn = (section) => rowsIn(section).map((el) => within(el).getByTestId('resinv-target').textContent);
const rowOf = (text) => screen.getAllByTestId('resinv-row').find((el) => within(el).getByTestId('resinv-target').textContent === text);
const shownTargets = () => screen.queryAllByTestId('resinv-row').map((el) => within(el).getByTestId('resinv-target').textContent);
const pick = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const withWarnings = (extra) => ({ ...DTO, warnings: { ...DTO.warnings, ...extra } });

describe('ResourcesInventory · el DTO de Core se pinta tal cual', () => {
  it('cada categoría de Core va a su sección, sin mezclarse', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(targetsIn('scan_ok')).toEqual(['/home/ana/app']);
    expect(targetsIn('scan_unavailable')).toEqual(['/home/ana/roto']);
    expect(targetsIn('scan_other_machine')).toEqual(['/srv/remoto']);
    expect(targetsIn('tracked')).toEqual(['/home/ana/app.lixbon-wt/wt-c']);
    expect(targetsIn('missing_on_disk')).toEqual(['/home/ana/app.lixbon-wt/wt-falta']);
    expect(targetsIn('not_registered')).toEqual(['/home/ana/app.lixbon-wt/wt-no-reg']);
    expect(targetsIn('orphan_candidate')).toEqual(['/home/ana/app.lixbon-wt/wt-huerfano']);
    expect(targetsIn('external')).toEqual(['/otro/wt']);
    expect(targetsIn('unknown')).toEqual(['/home/ana/app.lixbon-wt/wt-desconocido']);
    expect(targetsIn('preserved')).toEqual(['lx/r/g']);
    expect(screen.getByTestId('resinv-shown').textContent).toBe('Mostrando 10 de 10');
  });

  it('el estado de Core se muestra con su vocabulario, sin renombrarlo', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-c'));
    expect(row.getByTestId('resinv-core-state').textContent).toBe('tracked');
    expect(row.getByTestId('resinv-state').textContent).toBe('Registrado');
    expect(row.getByTestId('resinv-origin').textContent).toBe('Task de Lixbon');
    expect(row.getByTestId('resinv-project').textContent).toBe('p-1');
    expect(row.getByTestId('resinv-machine').textContent).toBe('m-1');
    expect(row.getByTestId('resinv-repo').textContent).toBe('/home/ana/app');
    expect(row.getByTestId('resinv-branch').textContent).toBe('lx/r/c');
    expect(row.getByTestId('resinv-into').textContent).toBe('main');
  });

  it('los metadatos del DTO se pintan tal cual: ruta, rama, repo, destino y propietario', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-c'));
    expect(row.getByTestId('resinv-target').textContent).toBe('/home/ana/app.lixbon-wt/wt-c');
    expect(row.getByTestId('resinv-owner').textContent).toBe('t-9');
    expect(row.getByTestId('resinv-run').textContent).toBe('r-1');
    expect(row.getByTestId('resinv-owner-status').textContent).toBe('done');
    expect(row.getByTestId('resinv-dirty').textContent).toBe('Limpio');
    expect(row.getByTestId('resinv-merged').textContent).toBe('Sin fusionar');
  });

  it('la rama conservada es una sección propia, con su rama y su dueño', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('lx/r/g'));
    expect(row.getByTestId('resinv-state').textContent).toBe('Rama conservada');
    expect(row.getByTestId('resinv-branch').textContent).toBe('lx/r/g');
    expect(row.getByTestId('resinv-branch-exists').textContent).toBe('Sí');
    expect(row.getByTestId('resinv-owner').textContent).toBe('t-4');
    expect(row.getByTestId('resinv-merged').textContent).toBe('Sin fusionar');
  });
});

describe('ResourcesInventory · falta, desconocido y no disponible', () => {
  it('missing_on_disk es falta aunque git no haya podido preguntar', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-falta'));
    expect(row.getByTestId('resinv-state').textContent).toBe('Falta en disco');
    expect(row.getByTestId('resinv-physical').textContent).toBe('Falta');
    // git no respondió: se dice, pero no convierte la fila en «desconocido».
    expect(row.getByTestId('resinv-registered').textContent).toBe('No se pudo comprobar');
    expect(targetsIn('missing_on_disk')).toContain('/home/ana/app.lixbon-wt/wt-falta');
    expect(targetsIn('unknown')).not.toContain('/home/ana/app.lixbon-wt/wt-falta');
  });

  it('un worktree que git registra pero no está en disco se marca como podable (la query no lo poda)', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-falta'));
    expect(row.getByTestId('resinv-prunable').textContent).toContain('podable');
  });

  it('unknown no es falta: ni la etiqueta ni el texto de la fila lo dicen', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-desconocido'));
    expect(row.getByTestId('resinv-state').textContent).toBe('Desconocido');
    expect(row.getByTestId('resinv-physical').textContent).toBe('Desconocido');
    expect(row.getByTestId('resinv-dirty').textContent).toBe('Desconocido');
    expect(row.getByTestId('resinv-merged').textContent).toBe('Desconocido');
    expect(row.queryByText('Falta')).toBeNull();
    expect(rowOf('/home/ana/app.lixbon-wt/wt-desconocido').textContent).not.toMatch(/Falta/);
  });

  it('un repo con escaneo no disponible no es falta y no se mezcla con los desconocidos', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/roto'));
    expect(row.getByTestId('resinv-state').textContent).toBe('No disponible');
    expect(row.getByTestId('resinv-scan').textContent).toBe('unavailable');
    expect(row.getByTestId('resinv-reason').textContent).toBe('No es un repositorio');
    expect(row.queryByText('Falta')).toBeNull();
    expect(targetsIn('unknown')).not.toContain('/home/ana/roto');
    expect(targetsIn('scan_unavailable')).toEqual(['/home/ana/roto']);
  });

  it('skipped (no evaluado) se muestra distinto de unknown', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const skipped = within(rowOf('/home/ana/app.lixbon-wt/wt-falta'));
    const unknown = within(rowOf('/home/ana/app.lixbon-wt/wt-desconocido'));
    expect(skipped.getByTestId('resinv-dirty').textContent).toBe('No evaluado');
    expect(skipped.getByTestId('resinv-merged').textContent).toBe('No evaluado');
    expect(unknown.getByTestId('resinv-dirty').textContent).toBe('Desconocido');
    expect(skipped.getByTestId('resinv-dirty').textContent).not.toBe(unknown.getByTestId('resinv-dirty').textContent);
  });

  it('owner null es «sin propietario», no «desconocido»', () => {
    render(<ResourcesInventory inventory={DTO} />);
    for (const targetText of ['/home/ana/app.lixbon-wt/wt-huerfano', '/otro/wt']) {
      const row = within(rowOf(targetText));
      expect(row.getByTestId('resinv-owner').textContent).toBe('Sin propietario');
      // El campo del propietario no dice «Desconocido» (aunque otro campo de la fila sí lo diga).
      expect(row.getByTestId('resinv-owner').textContent).not.toBe('Desconocido');
      expect(row.getByTestId('resinv-run').textContent).toBe('—');
    }
  });
});

describe('ResourcesInventory · needs_review gobierna el aviso y el filtro', () => {
  it('el aviso aparece solo donde Core dice needs_review', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(within(rowOf('/home/ana/app.lixbon-wt/wt-c')).getByTestId('resinv-needs-review').textContent).toBe('Por revisar');
    expect(within(rowOf('lx/r/g')).getByTestId('resinv-needs-review').textContent).toBe('Por revisar');
    // Sin fusionar NO es aviso: lo decide `needs_review`, no `merged`.
    expect(within(rowOf('/home/ana/app.lixbon-wt/wt-huerfano')).queryByTestId('resinv-needs-review')).toBeNull();
    expect(within(rowOf('/home/ana/app.lixbon-wt/wt-falta')).queryByTestId('resinv-needs-review')).toBeNull();
  });

  it('needs_review null (sin probe) se dice «revisión no evaluada», no «por revisar»', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/home/ana/app.lixbon-wt/wt-desconocido'));
    expect(row.queryByTestId('resinv-needs-review')).toBeNull();
    expect(row.getByTestId('resinv-review-unknown').textContent).toBe('Revisión no evaluada');
  });

  it('una rama conservada sin fusionar es un aviso, no un error de integridad', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('lx/r/g'));
    const tag = row.getByTestId('resinv-needs-review');
    expect(tag.className).toContain('resinv__tag--warning');
    expect(tag.className).not.toMatch(/error|danger/);
    expect(rowOf('lx/r/g').textContent).not.toMatch(/error|integridad/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('el filtro «Revisión» muestra solo lo que Core marca para revisar', () => {
    render(<ResourcesInventory inventory={DTO} />);
    pick('Revisión', 'needs_review');
    expect(shownTargets().sort()).toEqual(['/home/ana/app.lixbon-wt/wt-c', 'lx/r/g']);
    // Los repos no tienen `needs_review`: no aparecen.
    expect(shownTargets()).not.toContain('/home/ana/app');
    pick('Revisión', 'all');
    expect(shownTargets()).toHaveLength(10);
  });

  it('una rama sin fusionar con needs_review false no aparece en el filtro de aviso', () => {
    const dto = {
      ...DTO,
      preserved_branches: [{ ...DTO.preserved_branches[0], merged: 'unmerged', needs_review: false }],
    };
    render(<ResourcesInventory inventory={dto} />);
    pick('Revisión', 'needs_review');
    expect(shownTargets()).not.toContain('lx/r/g');
  });
});

describe('ResourcesInventory · el contador de avisos es el de Core', () => {
  it('muestra warnings.branches_to_review tal cual, aunque no coincida con las filas', () => {
    render(<ResourcesInventory inventory={withWarnings({ branches_to_review: 7 })} />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 7');
  });

  it('no cambia con los filtros', () => {
    render(<ResourcesInventory inventory={withWarnings({ branches_to_review: 3 })} />);
    pick('Estado', 'external');
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 3');
  });

  it('0 de Core se muestra como 0', () => {
    render(<ResourcesInventory inventory={withWarnings({ branches_to_review: 0 })} />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 0');
  });

  it.each([[null], [undefined], ['4'], [-1], [2.5], [NaN]])(
    'sin un entero ≥ 0 de Core no hay contador (y no se deriva de las filas): %s',
    (bad) => {
      const dto = { ...DTO, warnings: { branches_to_review: bad } };
      render(<ResourcesInventory inventory={dto} />);
      expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
      // Hay filas que necesitan revisión y aun así no hay contador.
      expect(screen.getAllByTestId('resinv-needs-review').length).toBe(2);
    },
  );

  it('sin warnings no hay contador', () => {
    render(<ResourcesInventory inventory={{ ...DTO, warnings: undefined }} />);
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
  });

  it('probe=false con branches_to_review null: estado sin contador, sin número ni «0 por revisar»', () => {
    const dto = {
      ...DTO,
      filters: { project_id: null, probe: false },
      warnings: { ...DTO.warnings, branches_to_review: null },
    };
    render(<ResourcesInventory inventory={dto} />);
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
    const note = screen.getByTestId('resinv-count-unavailable');
    expect(note.textContent).toContain('filters.probe=false');
    expect(note.textContent).toContain('no hay contador');
    expect(note.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/Ramas por revisar \(Core/)).toBeNull();
  });

  it('branches_to_review null con probe=true no culpa a probe: dice que Core no informó un contador válido', () => {
    render(<ResourcesInventory inventory={withWarnings({ branches_to_review: null })} />);
    const note = screen.getByTestId('resinv-count-unavailable');
    expect(note.textContent).toContain('no informó un contador válido');
    expect(note.textContent).not.toContain('probe=false');
  });

  it('contador null de una petición acotada a otro Project: solo «sin contador», sin afirmar que hay un contador de otro Project', () => {
    const dto = { ...DTO, filters: { project_id: 'p-2', probe: true }, warnings: { ...DTO.warnings, branches_to_review: null } };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
    expect(screen.getByTestId('resinv-count-unavailable').textContent).toContain('no informó un contador válido');
    // No hay número de Core que atribuir a otro Project: el aviso de «otro Project» sería contradictorio.
    expect(screen.queryByTestId('resinv-count-foreign')).toBeNull();
    expect(screen.queryByTestId('resinv-count-scope-note')).toBeNull();
    expect(screen.queryByText(/corresponde a otro Project/)).toBeNull();
    // Y con probe=false pasa lo mismo: solo se dice que Core no evaluó.
    cleanup();
    render(<ResourcesInventory inventory={{ ...dto, filters: { project_id: 'p-2', probe: false } }} projectId="p-1" />);
    expect(screen.getByTestId('resinv-count-unavailable').textContent).toContain('filters.probe=false');
    expect(screen.queryByTestId('resinv-count-foreign')).toBeNull();
  });

  it('contador null con un recurso que falta en disco: el aviso no contradice las filas', () => {
    const dto = { ...DTO, filters: { project_id: 'p-2', probe: true }, warnings: { branches_to_review: null } };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(targetsIn('missing_on_disk')).toEqual(['/home/ana/app.lixbon-wt/wt-falta']);
    expect(screen.getByTestId('resinv-count-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('resinv-count-foreign')).toBeNull();
  });

  it('con un número de Core de otro Project sigue valiendo el aviso de «otro Project» y no el de «sin contador»', () => {
    const dto = { ...DTO, filters: { project_id: 'p-2', probe: true } };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(screen.getByTestId('resinv-count-foreign')).toBeTruthy();
    expect(screen.queryByTestId('resinv-count-unavailable')).toBeNull();
  });

  it('con contador numérico de Core no aparece el aviso de «sin contador» (el número sigue siendo autoritativo)', () => {
    render(<ResourcesInventory inventory={withWarnings({ branches_to_review: 2 })} />);
    expect(screen.queryByTestId('resinv-count-unavailable')).toBeNull();
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 2');
  });
});

describe('ResourcesInventory · se acota por Project ID', () => {
  const FOREIGN = {
    ...DTO,
    worktrees: [
      ...DTO.worktrees,
      {
        target: { machine: 'm-1', project_id: 'p-otro', repo: '/home/ana/otro', path: '/home/ana/otro.lixbon-wt/wt' },
        state: 'tracked', origin: 'task', physical: 'present',
        git: { registered: true, branch: 'lx/r/x', detached: false, locked: false, prunable: false },
        owner: { task_id: 't-99', run_id: 'r-9', status: 'done' },
        dirty: 'clean', merged: 'merged', into: 'main', needs_review: false,
      },
    ],
  };

  it('las filas de otro Project no se pintan y se avisa de que se omitieron', () => {
    render(<ResourcesInventory inventory={FOREIGN} projectId="p-1" />);
    // El worktree de p-otro y los repos de p-2 y p-3 son de otros Projects.
    expect(shownTargets()).not.toContain('/home/ana/otro.lixbon-wt/wt');
    expect(shownTargets()).not.toContain('/home/ana/roto');
    expect(shownTargets()).not.toContain('/srv/remoto');
    expect(screen.getByTestId('resinv-foreign-omitted')).toBeTruthy();
    expect(screen.getByTestId('resinv-shown').textContent).toBe('Mostrando 8 de 8');
  });

  it('sin projectId se ve todo lo que llegó', () => {
    render(<ResourcesInventory inventory={FOREIGN} />);
    expect(shownTargets()).toContain('/home/ana/otro.lixbon-wt/wt');
    expect(screen.queryByTestId('resinv-foreign-omitted')).toBeNull();
  });

  it('lo que no trae project_id se conserva: no se puede afirmar que sea de otro Project', () => {
    const dto = {
      ...DTO,
      worktrees: [
        {
          target: { machine: 'm-1', project_id: null, repo: '/home/ana/app', path: '/home/ana/app.lixbon-wt/sin-proyecto' },
          state: 'tracked', origin: 'task', physical: 'present',
          git: { registered: true, branch: 'lx/r/s', detached: false, locked: false, prunable: false },
          owner: { task_id: 't-98', run_id: 'r-8', status: 'done' },
          dirty: 'clean', merged: 'merged', into: 'main', needs_review: false,
        },
      ],
    };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(shownTargets()).toContain('/home/ana/app.lixbon-wt/sin-proyecto');
  });

  it('el filtro de proyecto usa el Project ID del DTO', () => {
    render(<ResourcesInventory inventory={FOREIGN} />);
    const opts = [...screen.getByLabelText('Proyecto').options].map((o) => o.value);
    expect(opts).toEqual(['all', 'p-1', 'p-2', 'p-3', 'p-otro']);
    pick('Proyecto', 'p-2');
    expect(shownTargets()).toEqual(['/home/ana/roto']);
  });

  it('scopeByProject no filtra por ProjectLocation: solo por project_id', () => {
    const { rows } = readInventory(FOREIGN);
    const scoped = scopeByProject(rows, 'p-1');
    // Se omiten tres filas de otros Projects (un worktree y dos repos), no por su ruta.
    expect(scoped.omitted).toBe(3);
    expect(scoped.rows.every((r) => r.projectId === null || r.projectId === 'p-1')).toBe(true);
    expect(scoped.rows.some((r) => r.projectId === 'p-otro')).toBe(false);
  });
});

describe('ResourcesInventory · repos en otro host', () => {
  it('el repo de otra máquina va a su propia sección, con su motivo', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const row = within(rowOf('/srv/remoto'));
    expect(row.getByTestId('resinv-state').textContent).toBe('Otro equipo');
    expect(row.getByTestId('resinv-machine').textContent).toBe('otro-equipo');
    expect(row.getByTestId('resinv-scan').textContent).toBe('other_machine');
    expect(row.getByTestId('resinv-reason').textContent).toBe('El repo está en otro equipo');
    expect(targetsIn('scan_other_machine')).toEqual(['/srv/remoto']);
    expect(targetsIn('scan_unavailable')).not.toContain('/srv/remoto');
  });

  it('el escaneo no disponible y el de otro equipo son secciones distintas', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(targetsIn('scan_unavailable')).toEqual(['/home/ana/roto']);
    expect(targetsIn('scan_other_machine')).toEqual(['/srv/remoto']);
    expect(screen.getByTestId('resinv-section-scan_unavailable')).not.toBe(screen.getByTestId('resinv-section-scan_other_machine'));
  });
});

describe('ResourcesInventory · filtros', () => {
  it('Estado: cada categoría se filtra por separado', () => {
    render(<ResourcesInventory inventory={DTO} />);
    pick('Estado', 'tracked');
    expect(shownTargets()).toEqual(['/home/ana/app.lixbon-wt/wt-c']);
    pick('Estado', 'missing_on_disk');
    expect(shownTargets()).toEqual(['/home/ana/app.lixbon-wt/wt-falta']);
    pick('Estado', 'unknown');
    expect(shownTargets()).toEqual(['/home/ana/app.lixbon-wt/wt-desconocido']);
    pick('Estado', 'preserved');
    expect(shownTargets()).toEqual(['lx/r/g']);
    pick('Estado', 'scan_other_machine');
    expect(shownTargets()).toEqual(['/srv/remoto']);
  });

  it('los filtros se combinan (AND) y el vacío tiene mensaje propio', () => {
    render(<ResourcesInventory inventory={DTO} />);
    pick('Proyecto', 'p-1');
    pick('Estado', 'tracked');
    expect(shownTargets()).toEqual(['/home/ana/app.lixbon-wt/wt-c']);
    pick('Revisión', 'needs_review');
    expect(shownTargets()).toEqual(['/home/ana/app.lixbon-wt/wt-c']);
    pick('Estado', 'external');
    expect(shownTargets()).toEqual([]);
    expect(screen.getByTestId('resinv-no-match')).toBeTruthy();
  });

  it('las secciones vacías no se pintan', () => {
    render(<ResourcesInventory inventory={DTO} />);
    pick('Estado', 'external');
    expect(screen.queryByTestId('resinv-section-tracked')).toBeNull();
    expect(screen.queryByTestId('resinv-section-preserved')).toBeNull();
    expect(screen.getByTestId('resinv-section-external')).toBeTruthy();
  });

  it('opción «Sin proyecto» solo si hay filas sin project_id', () => {
    const dto = {
      ...DTO,
      repos: [{ project_id: null, machine: 'm-1', path: '/home/ana/sin-proyecto', scan: 'ok' }],
    };
    render(<ResourcesInventory inventory={dto} />);
    pick('Proyecto', '__none__');
    expect(shownTargets()).toEqual(['/home/ana/sin-proyecto']);
  });
});

describe('ResourcesInventory · sin inventario', () => {
  it('ausente = no disponible, y no dice que el contrato esté pendiente', () => {
    render(<ResourcesInventory />);
    const notice = screen.getByTestId('resinv-unavailable-inventory');
    expect(notice.textContent).toContain('no disponible');
    expect(notice.textContent).not.toMatch(/LXO-93|Backlog|pendiente/i);
    expect(screen.queryByTestId('resinv-shown')).toBeNull();
    expect(screen.queryAllByTestId('resinv-row')).toHaveLength(0);
    expect(screen.queryByLabelText('Proyecto')).toBeNull();
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
  });

  it.each([[{}], [{ repos: null, worktrees: null, preserved_branches: null }], [{ worktrees: 'x' }], [{ repos: { a: 1 } }]])(
    'un DTO sin las listas contractuales = no disponible, sin filas inventadas: %j',
    (bad) => {
      render(<ResourcesInventory inventory={bad} />);
      expect(screen.getByTestId('resinv-unavailable-inventory')).toBeTruthy();
      expect(screen.queryAllByTestId('resinv-row')).toHaveLength(0);
    },
  );

  it('listas vacías = Core no informa recursos', () => {
    render(<ResourcesInventory inventory={{ v: 1, machine: 'm-1', repos: [], worktrees: [], preserved_branches: [], warnings: { branches_to_review: 0 } }} />);
    expect(screen.getByText('Core no informa recursos.')).toBeTruthy();
    expect(screen.getByTestId('resinv-shown').textContent).toBe('Mostrando 0 de 0');
  });

  it('entradas nulas o no objeto se ignoran sin romper', () => {
    const dto = { ...DTO, worktrees: [null, 3, ...DTO.worktrees] };
    render(<ResourcesInventory inventory={dto} />);
    expect(shownTargets()).toHaveLength(10);
  });
});

describe('ResourcesInventory · solo lectura', () => {
  it('no hay botones ni enlaces: ruta y rama son metadato, no acciones', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(document.querySelectorAll('button, a, input, textarea, form, [onclick], [role="button"]')).toHaveLength(0);
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    // La ruta se pinta como texto plano.
    expect(rowOf('/home/ana/app.lixbon-wt/wt-c').querySelector('a')).toBeNull();
  });

  it('ninguna etiqueta ofrece borrar/archivar/adoptar/limpiar ni operaciones de Git', () => {
    render(<ResourcesInventory inventory={DTO} />);
    const forbidden = /eliminar|borrar|archivar|adoptar|limpiar|reparar|delete|archive|adopt|cleanup|repair|checkout|push|prune/i;
    // «git» solo puede aparecer describiendo el dato de Core, nunca como una acción.
    const DATA_PHRASES = /Registrado en git|git lo marca como podable|git no está instalado|git agotó el tiempo|git falló|No registrado en git/g;
    const visible = [...document.querySelectorAll('.resinv__row')].map((el) => el.textContent).join(' ');
    expect(visible.replace(DATA_PHRASES, '')).not.toMatch(forbidden);
    expect(visible.replace(DATA_PHRASES, '')).not.toMatch(/\bgit\b/i);
    const optionText = [...screen.getByLabelText('Estado').options].map((o) => o.textContent).join(' ');
    expect(optionText.replace(DATA_PHRASES, '')).not.toMatch(forbidden);
    expect(optionText.replace(DATA_PHRASES, '')).not.toMatch(/\bgit\b/i);
  });
});

describe('ResourcesInventory · helpers del contrato', () => {
  it('readInventory devuelve null sin DTO utilizable y las filas con su sección', () => {
    expect(readInventory(null)).toBeNull();
    expect(readInventory({})).toBeNull();
    const { rows, branchesToReview } = readInventory(DTO);
    expect(rows).toHaveLength(10);
    expect(branchesToReview).toBe(2);
    expect(sectionOf(rows.find((r) => r.kind === 'worktree' && r.coreState === 'tracked'))).toBe('tracked');
  });

  it('matchesState y matchesReview usan la sección y needs_review de Core', () => {
    const { rows } = readInventory(DTO);
    const tracked = rows.find((r) => r.coreState === 'tracked');
    const orphan = rows.find((r) => r.coreState === 'orphan_candidate');
    const repo = rows.find((r) => r.kind === 'repo' && r.coreState === 'ok');
    expect(matchesState(tracked, 'tracked')).toBe(true);
    expect(matchesState(tracked, 'orphan_candidate')).toBe(false);
    expect(matchesState(tracked, 'all')).toBe(true);
    expect(matchesReview(tracked, 'needs_review')).toBe(true);
    expect(matchesReview(orphan, 'needs_review')).toBe(false);
    expect(matchesReview(repo, 'needs_review')).toBe(false);
    expect(matchesReview(repo, 'all')).toBe(true);
  });

  it('isMissing solo reconoce el estado missing_on_disk de Core', () => {
    const { rows } = readInventory(DTO);
    const missing = rows.find((r) => r.coreState === 'missing_on_disk');
    const unknown = rows.find((r) => r.coreState === 'unknown');
    const repo = rows.find((r) => r.kind === 'repo' && r.coreState === 'unavailable');
    expect(isMissing(missing)).toBe(true);
    expect(isMissing(unknown)).toBe(false);
    expect(isMissing(repo)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remediación de la revisión de LXO-101.
const wt = (over = {}) => ({
  target: target({ path: '/home/ana/app.lixbon-wt/wt-x' }),
  state: 'tracked', origin: 'task', physical: 'present',
  git: { registered: true, branch: 'lx/r/x', detached: false, locked: false, prunable: false },
  owner: { task_id: 't-1', run_id: 'r-1', status: 'done' },
  dirty: 'clean', merged: 'merged', into: 'main', needs_review: false,
  ...over,
});
const only = (over) => ({ ...DTO, repos: [], preserved_branches: [], worktrees: [wt(over)] });
const onlyRepo = (over) => ({ ...DTO, worktrees: [], preserved_branches: [], repos: [{ project_id: 'p-1', machine: 'm-1', path: '/home/ana/raro', scan: 'ok', ...over }] });
const WT_X = '/home/ana/app.lixbon-wt/wt-x';

describe('ResourcesInventory · alcance del contador de Core (docs/core/RESOURCES.md §Aviso)', () => {
  it('la etiqueta dice el alcance de la petición: todos los Projects si filters.project_id es null', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 2');
    expect(screen.queryByTestId('resinv-count-scope-note')).toBeNull();
  });

  it('con un Project seleccionado, un contador de todos los Projects no se presenta como el de ese Project', () => {
    render(<ResourcesInventory inventory={DTO} projectId="p-1" />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toContain('todos los Projects');
    expect(screen.getByTestId('resinv-count-scope-note').textContent).toContain('no es el de este Project');
  });

  it('el contador no se recalcula con las filas omitidas ni con los filtros locales', () => {
    const dto = withWarnings({ branches_to_review: 9 });
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 9');
    pick('Proyecto', 'p-1');
    pick('Revisión', 'needs_review');
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 9');
  });

  it('si la petición fue acotada al mismo Project, la etiqueta lo dice y no hay aviso de alcance', () => {
    const dto = { ...DTO, filters: { project_id: 'p-1', probe: true } };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, Project p-1): 2');
    expect(screen.queryByTestId('resinv-count-scope-note')).toBeNull();
  });

  it('si la petición fue acotada a otro Project, el contador no se atribuye a este', () => {
    const dto = { ...DTO, filters: { project_id: 'p-2', probe: true } };
    render(<ResourcesInventory inventory={dto} projectId="p-1" />);
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
    expect(screen.getByTestId('resinv-count-foreign').textContent).toContain('otro Project (Project p-2)');
  });

  it.each([[undefined], [null], ['x'], [{ probe: true }], [{ project_id: '', probe: true }], [{ project_id: 3 }]])(
    'sin filters.project_id legible el alcance es «no informado», no se supone: %j',
    (filters) => {
      render(<ResourcesInventory inventory={{ ...DTO, filters }} />);
      expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, alcance no informado): 2');
    },
  );
});

describe('ResourcesInventory · versión del DTO', () => {
  it('v: 1 es la única versión compatible y se pinta con normalidad', () => {
    render(<ResourcesInventory inventory={DTO} />);
    expect(screen.queryByTestId('resinv-incompatible-version')).toBeNull();
    expect(screen.getAllByTestId('resinv-row')).toHaveLength(10);
  });

  it.each([[2], [0], ['1'], [1.5], [null], [undefined], [true]])(
    'v=%j no es compatible: estado desconocido, sin filas, sin filtros y sin contador',
    (v) => {
      render(<ResourcesInventory inventory={{ ...DTO, v }} />);
      const notice = screen.getByTestId('resinv-incompatible-version');
      expect(notice.textContent).toContain('no compatible');
      expect(notice.textContent).toContain('v=1');
      expect(notice.textContent).toMatch(/desconocido/i);
      expect(screen.queryAllByTestId('resinv-row')).toHaveLength(0);
      expect(screen.queryByTestId('resinv-shown')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
      expect(screen.queryByTestId('resinv-unavailable-inventory')).toBeNull();
    },
  );

  it('dice la versión recibida, o que no hay versión', () => {
    const { unmount } = render(<ResourcesInventory inventory={{ ...DTO, v: 2 }} />);
    expect(screen.getByTestId('resinv-incompatible-version').textContent).toContain('(v=2)');
    unmount();
    const { v: _omitida, ...sinVersion } = DTO;
    render(<ResourcesInventory inventory={sinVersion} />);
    expect(screen.getByTestId('resinv-incompatible-version').textContent).toContain('sin versión');
  });

  it.each([[2], [0], ['1']])(
    'v=%j declarada sin ninguna lista es versión incompatible, no «Core no ha entregado el inventario»',
    (v) => {
      render(<ResourcesInventory inventory={{ v, machine: 'm-1' }} />);
      const notice = screen.getByTestId('resinv-incompatible-version');
      expect(notice.textContent).toContain('no compatible');
      expect(screen.queryByTestId('resinv-unavailable-inventory')).toBeNull();
      expect(screen.queryByText(/no ha entregado/i)).toBeNull();
      expect(screen.queryAllByTestId('resinv-row')).toHaveLength(0);
      expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
      expect(screen.queryByTestId('resinv-count-unavailable')).toBeNull();
    },
  );

  it.each([[null], [undefined]])('v=%j (ausente) sin ninguna lista es «Core no ha entregado», no una versión incompatible declarada', (v) => {
    render(<ResourcesInventory inventory={{ v, machine: 'm-1' }} />);
    expect(screen.getByTestId('resinv-unavailable-inventory').textContent).toContain('no ha entregado');
    expect(screen.queryByTestId('resinv-incompatible-version')).toBeNull();
    expect(screen.queryAllByTestId('resinv-row')).toHaveLength(0);
    expect(readInventory({ v, machine: 'm-1' })).toBeNull();
  });

  it('v null con listas se trata como v ausente: incompatible «sin versión», igual que sin la clave', () => {
    const { unmount } = render(<ResourcesInventory inventory={{ ...DTO, v: null }} />);
    const conNull = screen.getByTestId('resinv-incompatible-version').textContent;
    expect(conNull).toContain('sin versión');
    expect(conNull).not.toContain('v=null');
    unmount();
    const { v: _omitida, ...sinVersion } = DTO;
    render(<ResourcesInventory inventory={sinVersion} />);
    expect(screen.getByTestId('resinv-incompatible-version').textContent).toBe(conNull);
  });

  it('v: 1 sin listas sigue siendo «Core no ha entregado el inventario»', () => {
    render(<ResourcesInventory inventory={{ v: 1, machine: 'm-1' }} />);
    expect(screen.getByTestId('resinv-unavailable-inventory').textContent).toContain('no ha entregado');
    expect(screen.queryByTestId('resinv-incompatible-version')).toBeNull();
  });

  it('readInventory marca la versión no compatible y no entrega filas ni contador', () => {
    const parsed = readInventory({ ...DTO, v: 3 });
    expect(parsed.incompatible).toBe(true);
    expect(parsed.version).toBe(3);
    expect(parsed.rows).toEqual([]);
    expect(parsed.branchesToReview).toBeNull();
    expect(readInventory(DTO).incompatible).toBe(false);
  });
});

describe('ResourcesInventory · vocabulario desconocido de Core', () => {
  it('state desconocido va a «Desconocidos», con el valor crudo, y nunca es falta', () => {
    render(<ResourcesInventory inventory={only({ state: 'quarantined' })} />);
    expect(targetsIn('unknown')).toEqual([WT_X]);
    expect(screen.queryByTestId('resinv-section-missing_on_disk')).toBeNull();
    const row = within(rowOf(WT_X));
    expect(row.getByTestId('resinv-state').textContent).toBe('Desconocido («quarantined» no reconocido)');
    expect(row.getByTestId('resinv-core-state').textContent).toBe('quarantined');
    expect(row.queryByText('Falta en disco')).toBeNull();
  });

  it.each([[undefined], [null], [7], ['constructor'], ['']])('state %j (ausente o fuera de contrato) es desconocido', (state) => {
    render(<ResourcesInventory inventory={only({ state })} />);
    expect(targetsIn('unknown')).toEqual([WT_X]);
    expect(within(rowOf(WT_X)).getByTestId('resinv-state').textContent).toMatch(/^Desconocido/);
  });

  it('scan desconocido NO se colapsa en «No disponible»: va a Desconocidos', () => {
    render(<ResourcesInventory inventory={onlyRepo({ scan: 'degraded' })} />);
    expect(targetsIn('unknown')).toEqual(['/home/ana/raro']);
    expect(screen.queryByTestId('resinv-section-scan_unavailable')).toBeNull();
    expect(screen.queryByTestId('resinv-section-scan_ok')).toBeNull();
    const row = within(rowOf('/home/ana/raro'));
    expect(row.getByTestId('resinv-state').textContent).toBe('Desconocido («degraded» no reconocido)');
    expect(row.getByTestId('resinv-scan').textContent).toBe('degraded');
    expect(row.queryByText('No disponible')).toBeNull();
  });

  it.each([[undefined], [null], [''], ['constructor']])('scan %j fuera de contrato es desconocido, no «No disponible»', (scan) => {
    render(<ResourcesInventory inventory={onlyRepo({ scan })} />);
    expect(targetsIn('unknown')).toEqual(['/home/ana/raro']);
    expect(screen.queryByTestId('resinv-section-scan_unavailable')).toBeNull();
  });

  it('el filtro «Desconocido» incluye al repo con scan desconocido y no a los de scan unavailable', () => {
    const dto = { ...DTO, repos: [...DTO.repos, { project_id: 'p-1', machine: 'm-1', path: '/home/ana/raro', scan: 'degraded' }] };
    render(<ResourcesInventory inventory={dto} />);
    pick('Estado', 'unknown');
    expect(shownTargets().sort()).toEqual(['/home/ana/app.lixbon-wt/wt-desconocido', '/home/ana/raro']);
    pick('Estado', 'scan_unavailable');
    expect(shownTargets()).toEqual(['/home/ana/roto']);
  });

  it('origin desconocido es «Desconocido» con su valor, no una de las tres procedencias', () => {
    render(<ResourcesInventory inventory={only({ origin: 'cloud' })} />);
    const text = within(rowOf(WT_X)).getByTestId('resinv-origin').textContent;
    expect(text).toBe('Desconocido («cloud» no reconocido)');
    expect(text).not.toMatch(/Externo|Carpeta de Lixbon|Task de Lixbon/);
  });

  it('dirty desconocido es «Desconocido», distinto de «No evaluado» y de «Limpio»', () => {
    render(<ResourcesInventory inventory={only({ dirty: 'partial' })} />);
    const text = within(rowOf(WT_X)).getByTestId('resinv-dirty').textContent;
    expect(text).toBe('Desconocido («partial» no reconocido)');
    expect(text).not.toMatch(/No evaluado|Limpio|Con cambios/);
  });

  it.each([['origin'], ['dirty'], ['merged'], ['physical']])('%s ausente es «Desconocido»', (campo) => {
    render(<ResourcesInventory inventory={only({ [campo]: undefined })} />);
    expect(within(rowOf(WT_X)).getByTestId(`resinv-${campo}`).textContent).toBe('Desconocido');
  });

  it('physical y merged fuera de contrato son desconocidos, no «Falta»', () => {
    render(<ResourcesInventory inventory={only({ physical: 'gone', merged: 'maybe' })} />);
    const row = within(rowOf(WT_X));
    expect(row.getByTestId('resinv-physical').textContent).toBe('Desconocido («gone» no reconocido)');
    expect(row.getByTestId('resinv-merged').textContent).toBe('Desconocido («maybe» no reconocido)');
    expect(row.queryByText('Falta')).toBeNull();
  });

  it('git.registered y branch_exists fuera de true/false/null son desconocidos, no «No se pudo comprobar»', () => {
    const dto = { ...only({ git: { registered: 'tal vez', branch: 'b' } }), preserved_branches: [{ ...DTO.preserved_branches[0], branch_exists: 'quiza' }] };
    render(<ResourcesInventory inventory={dto} />);
    expect(within(rowOf(WT_X)).getByTestId('resinv-registered').textContent).toBe('Desconocido');
    expect(within(rowOf('lx/r/g')).getByTestId('resinv-branch-exists').textContent).toBe('Desconocido');
  });

  it('needs_review fuera de true/false/null es «Revisión desconocida», no «sin revisión»', () => {
    render(<ResourcesInventory inventory={only({ needs_review: 'quizá' })} />);
    const row = within(rowOf(WT_X));
    expect(row.getByTestId('resinv-review-unrecognized').textContent).toBe('Revisión desconocida');
    expect(row.queryByTestId('resinv-needs-review')).toBeNull();
    cleanup();
    render(<ResourcesInventory inventory={only({ needs_review: false })} />);
    expect(screen.queryByTestId('resinv-review-unrecognized')).toBeNull();
  });

  it('un motivo de repo desconocido se marca como Desconocido con el valor crudo, sin inventar su significado', () => {
    render(<ResourcesInventory inventory={onlyRepo({ scan: 'unavailable', reason: 'disk_on_fire' })} />);
    expect(within(rowOf('/home/ana/raro')).getByTestId('resinv-reason').textContent).toBe('Desconocido («disk_on_fire» no reconocido)');
    cleanup();
    render(<ResourcesInventory inventory={onlyRepo({ scan: 'unavailable', reason: 'constructor' })} />);
    expect(within(rowOf('/home/ana/raro')).getByTestId('resinv-reason').textContent).toBe('Desconocido («constructor» no reconocido)');
  });

  it('un motivo conocido sigue traducido y la ausencia de motivo es «—», no «Desconocido»', () => {
    render(<ResourcesInventory inventory={onlyRepo({ scan: 'unavailable', reason: 'git_failed' })} />);
    expect(within(rowOf('/home/ana/raro')).getByTestId('resinv-reason').textContent).toBe('git falló');
    cleanup();
    render(<ResourcesInventory inventory={onlyRepo({ scan: 'unavailable', reason: undefined })} />);
    expect(within(rowOf('/home/ana/raro')).getByTestId('resinv-reason').textContent).toBe('—');
  });
});

describe('ResourcesInventory · propietario', () => {
  it('owner sin task_id NO se presenta como «sin propietario»', () => {
    render(<ResourcesInventory inventory={only({ owner: { run_id: 'r-7', status: 'running' } })} />);
    const row = within(rowOf(WT_X));
    expect(row.getByTestId('resinv-owner').textContent).toBe('Propietario sin task_id');
    expect(row.getByTestId('resinv-owner').textContent).not.toMatch(/Sin propietario/i);
    expect(row.getByTestId('resinv-run').textContent).toBe('r-7');
    expect(row.getByTestId('resinv-owner-status').textContent).toBe('running');
  });

  it.each([[{}], [{ task_id: '' }], [{ task_id: null }], [{ task_id: 5 }]])('owner %j existe pero sin task_id utilizable', (owner) => {
    render(<ResourcesInventory inventory={only({ owner })} />);
    expect(within(rowOf(WT_X)).getByTestId('resinv-owner').textContent).toBe('Propietario sin task_id');
  });

  it.each([['t-1'], [3], [[]], [true]])('owner malformado %j no es «sin propietario»', (owner) => {
    render(<ResourcesInventory inventory={only({ owner })} />);
    expect(within(rowOf(WT_X)).getByTestId('resinv-owner').textContent).toBe('Propietario no reconocido');
  });

  it('owner ausente es «no informado», no «sin propietario»', () => {
    render(<ResourcesInventory inventory={only({ owner: undefined })} />);
    expect(within(rowOf(WT_X)).getByTestId('resinv-owner').textContent).toBe('Propietario no informado por Core');
  });

  it('owner null sigue siendo «Sin propietario» y owner con task_id muestra el task_id', () => {
    const dto = { ...DTO, repos: [], preserved_branches: [], worktrees: [wt({ owner: null }), wt({ target: target({ path: '/otro/wt-2' }) })] };
    render(<ResourcesInventory inventory={dto} />);
    expect(within(rowOf(WT_X)).getByTestId('resinv-owner').textContent).toBe('Sin propietario');
    expect(within(rowOf('/otro/wt-2')).getByTestId('resinv-owner').textContent).toBe('t-1');
  });

  it('una rama conservada con owner sin task_id tampoco afirma que no tiene propietario', () => {
    const dto = { ...DTO, preserved_branches: [{ ...DTO.preserved_branches[0], owner: { run_id: 'r-1', status: 'stopped' } }] };
    render(<ResourcesInventory inventory={dto} />);
    expect(within(rowOf('lx/r/g')).getByTestId('resinv-owner').textContent).toBe('Propietario sin task_id');
  });
});

describe('ResourcesInventory · cambio de Project externo', () => {
  const MULTI = {
    ...DTO,
    worktrees: [
      ...DTO.worktrees,
      wt({ target: { machine: 'm-1', project_id: 'p-2', repo: '/home/ana/otro', path: '/home/ana/otro.lixbon-wt/wt-2' }, needs_review: true }),
    ],
  };

  it('al cambiar el projectId se restablecen los tres filtros locales', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} projectId="p-1" />);
    pick('Estado', 'tracked');
    pick('Revisión', 'needs_review');
    expect(screen.getByLabelText('Estado').value).toBe('tracked');
    expect(screen.getByLabelText('Revisión').value).toBe('needs_review');
    rerender(<ResourcesInventory inventory={MULTI} projectId="p-2" />);
    expect(screen.getByLabelText('Proyecto').value).toBe('all');
    expect(screen.getByLabelText('Estado').value).toBe('all');
    expect(screen.getByLabelText('Revisión').value).toBe('all');
    // Todo lo de p-2 se ve, no solo lo que casaba con los filtros del Project anterior.
    expect(shownTargets()).toEqual(['/home/ana/roto', '/home/ana/otro.lixbon-wt/wt-2']);
  });

  it('el filtro de Project local también se restablece', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} />);
    pick('Proyecto', 'p-2');
    expect(screen.getByLabelText('Proyecto').value).toBe('p-2');
    rerender(<ResourcesInventory inventory={MULTI} projectId="p-1" />);
    expect(screen.getByLabelText('Proyecto').value).toBe('all');
  });

  it('un filtro que dejaba la lista vacía no se arrastra al Project nuevo', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} projectId="p-1" />);
    pick('Estado', 'external');
    pick('Revisión', 'needs_review');
    expect(screen.getByTestId('resinv-no-match')).toBeTruthy();
    rerender(<ResourcesInventory inventory={MULTI} projectId="p-2" />);
    expect(screen.queryByTestId('resinv-no-match')).toBeNull();
    expect(shownTargets().length).toBeGreaterThan(0);
  });

  it('si el projectId no cambia, los filtros se conservan al recibir otro DTO', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} projectId="p-1" />);
    pick('Estado', 'tracked');
    rerender(<ResourcesInventory inventory={{ ...MULTI }} projectId="p-1" />);
    expect(screen.getByLabelText('Estado').value).toBe('tracked');
  });

  it('pasar de un Project a «sin Project» y viceversa también restablece', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} projectId="p-1" />);
    pick('Estado', 'tracked');
    rerender(<ResourcesInventory inventory={MULTI} projectId={null} />);
    expect(screen.getByLabelText('Estado').value).toBe('all');
    pick('Estado', 'external');
    rerender(<ResourcesInventory inventory={MULTI} projectId="p-2" />);
    expect(screen.getByLabelText('Estado').value).toBe('all');
  });

  it('null, undefined y cadena vacía son la misma identidad «sin Project»: no se restablecen entre sí', () => {
    const { rerender } = render(<ResourcesInventory inventory={MULTI} projectId={null} />);
    pick('Estado', 'tracked');
    rerender(<ResourcesInventory inventory={MULTI} projectId="" />);
    rerender(<ResourcesInventory inventory={MULTI} projectId={undefined} />);
    expect(screen.getByLabelText('Estado').value).toBe('tracked');
  });
});
