import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ResourcesInventory, matchesState } from './ResourcesInventory';

afterEach(cleanup);

// Fixtures SINTÉTICAS: no hay contrato LXO-93 ni consulta viva; nada de esto viene de Core ni del disco.
const base = { taskId: 'task-1', runId: 'run-1', owner: 'agente-a', exists: true };
const FIX = {
  clean: { ...base, id: 'res-clean', classification: 'known', projectId: 'proj-a', hostId: 'host-1', branch: 'feat/limpia', path: '/wt/limpia', dirty: false, merged: true },
  dirty: { ...base, id: 'res-dirty', classification: 'known', projectId: 'proj-a', hostId: 'host-2', branch: 'feat/sucia', path: '/wt/sucia', dirty: true, merged: false },
  merged: { ...base, id: 'res-merged', classification: 'known', projectId: 'proj-b', hostId: 'host-1', branch: 'feat/fusionada', path: '/wt/fusionada', dirty: false, merged: true },
  unmerged: { ...base, id: 'res-unmerged', classification: 'known', projectId: 'proj-b', hostId: 'host-2', branch: 'feat/conservada', path: '/wt/conservada', dirty: false, merged: false },
  missing: { id: 'res-missing', classification: 'missing', projectId: 'proj-a', hostId: 'host-1', taskId: 'task-9', runId: null, owner: 'agente-b', branch: 'feat/perdida', path: '/wt/perdida', exists: false, dirty: null, merged: null },
  external: { id: 'res-external', classification: 'external_candidate', projectId: 'proj-b', hostId: 'host-1', branch: 'otra/rama', path: '/otro/wt', owner: 'intruso', exists: true, dirty: false, merged: null },
  unknown: { id: 'res-unknown', classification: 'known', projectId: 'proj-a', hostId: 'host-2', branch: 'feat/dudosa', path: '/wt/dudosa', owner: 'agente-c', exists: null, dirty: null },
  unavailable: { id: 'res-unavailable', classification: 'known', projectId: 'proj-c', hostId: 'host-3', branch: 'feat/lejana', path: null, owner: 'agente-d', availability: 'unavailable' },
};
const ALL = Object.values(FIX);
const inv = (extra = {}) => ({ resources: ALL, ...extra });

const rowOf = (id) => document.querySelector(`[data-resource-id="${id}"]`);
const shownIds = () => screen.queryAllByTestId('resinv-row').map((el) => el.getAttribute('data-resource-id'));
const pick = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('ResourcesInventory', () => {
  it('muestra todas las filas con ID duradero, IDs de proyecto/host/tarea/ejecución y ubicación como metadato', () => {
    render(<ResourcesInventory inventory={inv()} />);
    expect(shownIds()).toEqual(ALL.map((r) => r.id));
    const row = within(rowOf('res-clean'));
    expect(row.getByText('proj-a')).toBeTruthy();
    expect(row.getByText('host-1')).toBeTruthy();
    expect(row.getByText('task-1')).toBeTruthy();
    expect(row.getByText('run-1')).toBeTruthy();
    expect(row.getByTestId('resinv-branch').textContent).toBe('feat/limpia');
    expect(row.getByTestId('resinv-path').textContent).toBe('/wt/limpia');
    expect(row.getByText('Ubicación (metadato)')).toBeTruthy();
    expect(row.getByTestId('resinv-owner').textContent).toBe('agente-a');
  });

  it('limpio / con cambios / fusionado / sin fusionar se pintan según los valores de Core', () => {
    render(<ResourcesInventory inventory={inv()} />);
    const clean = within(rowOf('res-clean'));
    expect(clean.getByTestId('resinv-dirty').textContent).toBe('Limpio');
    expect(clean.getByTestId('resinv-merged').textContent).toBe('Fusionado');
    expect(within(rowOf('res-dirty')).getByTestId('resinv-dirty').textContent).toBe('Con cambios');
    expect(within(rowOf('res-unmerged')).getByTestId('resinv-merged').textContent).toBe('Sin fusionar');
    expect(within(rowOf('res-merged')).getByTestId('resinv-merged').textContent).toBe('Fusionado');
  });

  it('rama sin fusionar es un aviso, no un error de integridad', () => {
    render(<ResourcesInventory inventory={inv()} />);
    const warn = within(rowOf('res-unmerged')).getByTestId('resinv-unmerged-warning');
    expect(warn.className).toContain('resinv__tag--warning');
    expect(warn.className).not.toMatch(/error|danger/);
    expect(warn.textContent).toBe('Rama conservada sin fusionar');
    // Ni alert, ni la palabra «error»/«integridad» en la fila.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowOf('res-unmerged').textContent).not.toMatch(/error|integridad/i);
    // La fila fusionada y la limpia no llevan aviso.
    expect(within(rowOf('res-merged')).queryByTestId('resinv-unmerged-warning')).toBeNull();
    expect(within(rowOf('res-clean')).queryByTestId('resinv-unmerged-warning')).toBeNull();
  });

  it('falta: clasificado por Core; desconocido y no disponible NO son «Falta»', () => {
    render(<ResourcesInventory inventory={inv()} />);
    const missing = within(rowOf('res-missing'));
    expect(missing.getByTestId('resinv-class').textContent).toBe('Falta');
    expect(missing.getByTestId('resinv-exists').textContent).toBe('No');

    const unknown = within(rowOf('res-unknown'));
    expect(unknown.getByTestId('resinv-class').textContent).toBe('Conocido');
    expect(unknown.getByTestId('resinv-exists').textContent).toBe('Desconocido');
    expect(unknown.getByTestId('resinv-dirty').textContent).toBe('Desconocido');
    expect(unknown.getByTestId('resinv-merged').textContent).toBe('Desconocido');
    expect(unknown.queryByText('Falta')).toBeNull();
    // Desconocido no es «sin fusionar»: no hay aviso.
    expect(unknown.queryByTestId('resinv-unmerged-warning')).toBeNull();

    const unavailable = within(rowOf('res-unavailable'));
    expect(unavailable.getByTestId('resinv-unavailable').textContent).toBe('No disponible');
    expect(unavailable.getByTestId('resinv-exists').textContent).toBe('No disponible');
    expect(unavailable.getByTestId('resinv-dirty').textContent).toBe('No disponible');
    expect(unavailable.queryByText('Falta')).toBeNull();
    expect(unavailable.queryByTestId('resinv-unmerged-warning')).toBeNull();
    expect(unavailable.getByTestId('resinv-path').textContent).toBe('—');
  });

  it('conocido con exists=false: la etiqueta visible dice «Falta», coherente con Existe y el filtro', () => {
    const gone = { ...FIX.clean, id: 'res-gone', exists: false };
    render(<ResourcesInventory inventory={{ resources: [gone, FIX.unknown, FIX.external] }} />);
    const row = within(rowOf('res-gone'));
    expect(row.getByTestId('resinv-class').textContent).toBe('Falta');
    expect(row.getByTestId('resinv-class').className).toContain('resinv__tag--missing');
    expect(row.getByTestId('resinv-exists').textContent).toBe('No');
    pick('Estado', 'missing');
    expect(shownIds()).toEqual(['res-gone']);
    // Desconocido y candidato externo siguen sin ser «Falta».
    pick('Estado', 'all');
    expect(within(rowOf('res-unknown')).getByTestId('resinv-class').textContent).toBe('Conocido');
    expect(within(rowOf('res-external')).getByTestId('resinv-class').textContent).toBe('Candidato externo');
  });

  it('no disponible con exists=false no es «Falta»: el valor no es fiable', () => {
    const lejana = { ...FIX.unavailable, id: 'res-lejana', exists: false };
    render(<ResourcesInventory inventory={{ resources: [lejana] }} />);
    const row = within(rowOf('res-lejana'));
    expect(row.getByTestId('resinv-class').textContent).toBe('Conocido');
    expect(row.getByTestId('resinv-exists').textContent).toBe('No disponible');
    expect(row.queryByText('Falta')).toBeNull();
    expect(matchesState(lejana, 'missing')).toBe(false);
    expect(matchesState(lejana, 'unknown')).toBe(true);
  });

  it('candidato externo con exists=false mantiene «Candidato externo» y sin propietario', () => {
    const ext = { ...FIX.external, id: 'res-ext-gone', exists: false };
    render(<ResourcesInventory inventory={{ resources: [ext] }} />);
    const row = within(rowOf('res-ext-gone'));
    expect(row.getByTestId('resinv-class').textContent).toBe('Candidato externo');
    expect(row.getByTestId('resinv-owner').textContent).toBe('Sin propietario');
  });

  it('candidato externo: sin propietario aunque el dato lo traiga', () => {
    render(<ResourcesInventory inventory={inv()} />);
    const ext = within(rowOf('res-external'));
    expect(ext.getByTestId('resinv-class').textContent).toBe('Candidato externo');
    expect(ext.getByTestId('resinv-owner').textContent).toBe('Sin propietario');
    expect(rowOf('res-external').textContent).not.toContain('intruso');
  });

  it('un recurso conocido sin propietario informado se muestra como desconocido, no como «sin propietario»', () => {
    render(<ResourcesInventory inventory={{ resources: [{ ...FIX.clean, owner: null }] }} />);
    expect(screen.getByTestId('resinv-owner').textContent).toBe('Desconocido');
  });

  describe('filtros', () => {
    it('Proyecto', () => {
      render(<ResourcesInventory inventory={inv()} />);
      const opts = [...screen.getByLabelText('Proyecto').options].map((o) => o.value);
      expect(opts).toEqual(['all', 'proj-a', 'proj-b', 'proj-c']);
      pick('Proyecto', 'proj-b');
      expect(shownIds()).toEqual(['res-merged', 'res-unmerged', 'res-external']);
      expect(screen.getByTestId('resinv-shown').textContent).toBe('Mostrando 3 de 8');
    });

    it('Host', () => {
      render(<ResourcesInventory inventory={inv()} />);
      pick('Host', 'host-2');
      expect(shownIds()).toEqual(['res-dirty', 'res-unmerged', 'res-unknown']);
      pick('Host', 'host-3');
      expect(shownIds()).toEqual(['res-unavailable']);
    });

    it('Estado: conocido / externo / falta / desconocido', () => {
      render(<ResourcesInventory inventory={inv()} />);
      pick('Estado', 'external_candidate');
      expect(shownIds()).toEqual(['res-external']);
      pick('Estado', 'missing');
      expect(shownIds()).toEqual(['res-missing']);
      pick('Estado', 'known');
      expect(shownIds()).toEqual(['res-clean', 'res-dirty', 'res-merged', 'res-unmerged', 'res-unknown', 'res-unavailable']);
      pick('Estado', 'unknown');
      // Desconocido y no disponible juntos, y nunca el recurso que falta ni el candidato externo.
      expect(shownIds()).toEqual(['res-unknown', 'res-unavailable']);
    });

    it('Estado: limpio / con cambios / fusionado / sin fusionar', () => {
      render(<ResourcesInventory inventory={inv()} />);
      pick('Estado', 'dirty');
      expect(shownIds()).toEqual(['res-dirty']);
      pick('Estado', 'clean');
      expect(shownIds()).toEqual(['res-clean', 'res-merged', 'res-unmerged', 'res-external']);
      pick('Estado', 'merged');
      expect(shownIds()).toEqual(['res-clean', 'res-merged']);
      pick('Estado', 'unmerged');
      // «Desconocido» y «no disponible» no cuentan como sin fusionar.
      expect(shownIds()).toEqual(['res-dirty', 'res-unmerged']);
    });

    it('los filtros se combinan (AND) y el vacío tiene mensaje propio', () => {
      render(<ResourcesInventory inventory={inv()} />);
      pick('Proyecto', 'proj-a');
      pick('Host', 'host-1');
      expect(shownIds()).toEqual(['res-clean', 'res-missing']);
      pick('Estado', 'external_candidate');
      expect(shownIds()).toEqual([]);
      expect(screen.getByTestId('resinv-no-match')).toBeTruthy();
      pick('Estado', 'all');
      expect(shownIds()).toEqual(['res-clean', 'res-missing']);
    });

    it('opción «Sin proyecto» / «Sin host» solo si hay entradas sin ese ID', () => {
      const orphan = { id: 'res-orphan', classification: 'external_candidate', projectId: null, hostId: undefined };
      render(<ResourcesInventory inventory={{ resources: [FIX.clean, orphan] }} />);
      pick('Proyecto', '__none__');
      expect(shownIds()).toEqual(['res-orphan']);
      pick('Proyecto', 'all');
      pick('Host', '__none__');
      expect(shownIds()).toEqual(['res-orphan']);
      cleanup();
      render(<ResourcesInventory inventory={{ resources: [FIX.clean] }} />);
      expect([...screen.getByLabelText('Proyecto').options].map((o) => o.textContent)).toEqual(['Todos', 'proj-a']);
    });

    it('matchesState: dirty y unmerged pueden coincidir a la vez', () => {
      expect(matchesState(FIX.dirty, 'dirty')).toBe(true);
      expect(matchesState(FIX.dirty, 'unmerged')).toBe(true);
      expect(matchesState(FIX.unavailable, 'dirty')).toBe(false);
      expect(matchesState(FIX.unavailable, 'clean')).toBe(false);
    });
  });

  describe('contador de avisos', () => {
    it('lo muestra tal cual lo suministra Core, aunque no coincida con las filas', () => {
      // Hay exactamente 2 filas sin fusionar (dirty + unmerged); Core dice 7.
      render(<ResourcesInventory inventory={inv({ warningCount: 7 })} />);
      expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Avisos (Core): 7');
    });

    it('no cambia con los filtros', () => {
      render(<ResourcesInventory inventory={inv({ warningCount: 3 })} />);
      pick('Estado', 'external_candidate');
      expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Avisos (Core): 3');
    });

    it('0 suministrado por Core se muestra como 0', () => {
      render(<ResourcesInventory inventory={inv({ warningCount: 0 })} />);
      expect(screen.getByTestId('resinv-warning-count').textContent).toBe('Avisos (Core): 0');
    });

    it.each([[undefined], [null], ['4'], [-1], [2.5], [NaN]])('si Core no lo suministra (o es inválido: %s) no se muestra ni se deriva', (bad) => {
      render(<ResourcesInventory inventory={inv({ warningCount: bad })} />);
      expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
      expect(screen.queryByText(/Avisos \(Core\)/)).toBeNull();
      // Hay filas sin fusionar (candidatas a ser contadas heurísticamente) y aun así no hay contador.
      expect(screen.getAllByTestId('resinv-unmerged-warning').length).toBe(2);
    });
  });

  describe('sin inventario', () => {
    it('ausente = no disponible, no vacío ni «falta»', () => {
      render(<ResourcesInventory />);
      expect(screen.getByTestId('resinv-unavailable-inventory').textContent).toContain('no disponible');
      expect(screen.queryByTestId('resinv-row')).toBeNull();
      expect(screen.queryByLabelText('Proyecto')).toBeNull();
      expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
    });

    it('lista vacía = Core no informa recursos', () => {
      render(<ResourcesInventory inventory={{ resources: [] }} />);
      expect(screen.getByText('Core no informa recursos.')).toBeTruthy();
      expect(screen.getByTestId('resinv-shown').textContent).toBe('Mostrando 0 de 0');
    });
  });

  describe('solo lectura', () => {
    it('no hay botones ni enlaces ni controles de acción, solo los tres filtros', () => {
      render(<ResourcesInventory inventory={inv({ warningCount: 2 })} />);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryAllByRole('textbox')).toHaveLength(0);
      expect(screen.getAllByRole('combobox')).toHaveLength(3);
      expect(document.querySelectorAll('button, a, input, textarea, [onclick], [role="button"]')).toHaveLength(0);
    });

    it('ninguna etiqueta ofrece borrar/archivar/adoptar/limpiar/reparar ni operaciones de Git', () => {
      render(<ResourcesInventory inventory={inv({ warningCount: 2 })} />);
      const forbidden = /eliminar|borrar|archivar|adoptar|limpiar|reparar|delete|archive|adopt|cleanup|repair|\bgit\b|checkout|merge now|push|prune/i;
      // Texto visible y opciones de los filtros.
      expect(document.body.textContent).not.toMatch(forbidden);
    });
  });
});
