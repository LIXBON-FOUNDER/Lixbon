// Vigila que los clientes no se desvíen de contracts/status-vocabulary.json (slice H).
// No genera ni cambia nada: solo compara los nombres y textos que ya usa cada cliente con el
// contrato. Ver docs/VOCABULARIO.md. La parte de Rust vive en src-tauri/src/orch/vocab.rs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_LABELS, isFinal } from '../store/orchStore';
import { ATTENTION } from './attention';
import { TERMINAL_APPROVAL, FAILURE_REASONS } from './terminalApprovalContract';
import { SPAWN_OUTCOMES } from './spawn/spawnContract';
import { REVIEW_DECISIONS } from './review/reviewContract';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const leer = (...ruta) => readFileSync(resolve(RAIZ, ...ruta), 'utf8');
const contrato = JSON.parse(leer('contracts', 'status-vocabulary.json'));
const dominio = contrato.domain;
const presentacion = contrato.presentation;
const ids = (seccion) => dominio[seccion].ids;
const estados = dominio.task_status.items.map((i) => i.id);
const ordenados = (a) => [...a].sort();

describe('contrato: forma', () => {
  it('cada id es único y de máquina (snake_case) en las secciones con ids', () => {
    for (const [nombre, s] of Object.entries(dominio)) {
      if (!Array.isArray(s?.ids)) continue;
      expect(new Set(s.ids).size, nombre).toBe(s.ids.length);
    }
    for (const id of estados) expect(id).toMatch(/^[a-z][a-z_]*$/);
  });

  it('el dominio no trae etiquetas: todas las de interfaz están en presentation', () => {
    expect(JSON.stringify(dominio)).not.toMatch(/Arrancando|Trabajando|Terminada|Fallida|label/i);
    expect(Object.keys(presentacion.desktop.task_status_label)).toEqual(estados);
  });
});

describe('Desktop', () => {
  it('STATUS_LABELS tiene exactamente un texto por estado de la tarea y es el del contrato', () => {
    expect(ordenados(Object.keys(STATUS_LABELS))).toEqual(ordenados(estados));
    expect(STATUS_LABELS).toEqual(presentacion.desktop.task_status_label);
  });

  it('isFinal coincide con `final` para cada estado', () => {
    for (const { id, final } of dominio.task_status.items) expect(isFinal(id), id).toBe(final);
    expect(isFinal('nuevo_estado_inexistente')).toBe(false);
  });

  it('el estado de aprobación en la terminal es el del contrato', () => {
    expect(TERMINAL_APPROVAL.status).toBe('awaiting_terminal_approval');
    expect(estados).toContain(TERMINAL_APPROVAL.status);
  });

  it('los kinds de Attention son los del contrato', () => {
    expect(ordenados(Object.values(ATTENTION))).toEqual(ordenados(ids('attention_kind')));
  });

  it('los motivos de fallo que sabe explicar la interfaz son los del contrato', () => {
    expect(ordenados(Object.values(FAILURE_REASONS))).toEqual(ordenados(ids('failure_reason')));
  });

  it('los resultados del lanzamiento pendiente son los del contrato (más already_resolved)', () => {
    const esperados = [...ids('pending_spawn_state').filter((i) => i !== 'pending'), ...dominio.pending_spawn_state.ids_de_resultado_no_estado];
    expect(ordenados(Object.values(SPAWN_OUTCOMES))).toEqual(ordenados(esperados));
  });

  it('las decisiones de revisión son las del contrato', () => {
    expect(ordenados(Object.values(REVIEW_DECISIONS))).toEqual(ordenados(ids('review_decision')));
  });
});

describe('móvil (apps/mobile/src/screens/RemoteOrch.js, leído como texto)', () => {
  const fuente = leer('apps', 'mobile', 'src', 'screens', 'RemoteOrch.js');
  const lista = (re) => [...fuente.match(re)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const objeto = (re) => Object.fromEntries([...fuente.match(re)[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const finales = lista(/const FINAL = \[([^\]]*)\]/);
  const etiquetas = objeto(/const STATUS = \{([^}]*)\}/);
  const divergencias = presentacion.known_divergences;

  it('FINAL coincide con los estados finales del contrato', () => {
    expect(ordenados(finales)).toEqual(ordenados(estados.filter((id) => dominio.task_status.items.find((i) => i.id === id).final)));
  });

  it('todo estado con etiqueta en el móvil existe en el contrato', () => {
    for (const id of Object.keys(etiquetas)) expect(estados, id).toContain(id);
  });

  it('los estados sin etiqueta en el móvil son exactamente los declarados como divergencia', () => {
    const faltan = estados.filter((id) => !(id in etiquetas));
    expect(ordenados(faltan)).toEqual(ordenados(divergencias.mobile_status_missing));
  });

  it('las etiquetas del móvil son las del contrato', () => {
    expect(etiquetas).toEqual(presentacion.mobile.task_status_label);
  });

  it('la redacción distinta de la del Desktop es exactamente la declarada', () => {
    const distintos = Object.entries(etiquetas)
      .filter(([id, texto]) => texto.toLowerCase() !== STATUS_LABELS[id].toLowerCase())
      .map(([id]) => id);
    expect(ordenados(distintos)).toEqual(ordenados(divergencias.mobile_status_wording_differs_from_desktop));
  });
});

describe('grupos visuales', () => {
  it('cada estado tiene un grupo conocido', () => {
    const grupos = presentacion.visual_group.groups;
    expect(Object.keys(presentacion.visual_group.of_task_status)).toEqual(estados);
    for (const g of Object.values(presentacion.visual_group.of_task_status)) expect(grupos).toContain(g);
  });

  it('los estados finales con error o fallo comparten grupo, como en el Desktop y el móvil', () => {
    const g = presentacion.visual_group.of_task_status;
    expect(g.failed).toBe(g.exited);
  });
});
