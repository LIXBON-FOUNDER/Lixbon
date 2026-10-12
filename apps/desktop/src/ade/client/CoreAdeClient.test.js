import { describe, it, expect } from 'vitest';
import { createCoreAdeClient, METHOD_SLICES } from './CoreAdeClient';
import { ADE_METHODS, assertAdeClient } from './contract';
import { FIELD_SOURCES, undeclaredFields } from './fieldSources';
import { SLICES, INTENTS } from './intents';

describe('CoreAdeClient (esqueleto)', () => {
  it('cumple la interfaz para fijar el punto de sustitución', () => {
    const c = createCoreAdeClient();
    expect(assertAdeClient(c)).toBe(c);
    expect(c.source).toBe('core');
  });

  it('cada consulta rechaza con core_not_implemented y nombra el slice que la habilitará', async () => {
    const c = createCoreAdeClient();
    for (const m of ADE_METHODS.filter((x) => x !== 'subscribe')) {
      await expect(c[m](), m).rejects.toMatchObject({ code: 'core_not_implemented', method: m, slice: METHOD_SLICES[m] });
    }
  });

  it('subscribe lanza de forma síncrona (la interfaz es síncrona) con el slice E', () => {
    expect(() => createCoreAdeClient().subscribe(() => {})).toThrowError(/E/);
  });

  it('no usa el transporte: el archivo no importa Tauri ni hace fetch', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const fuente = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'CoreAdeClient.js'), 'utf8');
    expect(fuente).not.toMatch(/@tauri-apps|invoke\(|orch_call|fetch\(/);
  });

  it('todo método tiene un slice asignado', () => {
    for (const m of ADE_METHODS) expect(METHOD_SLICES[m], m).toBeTruthy();
  });
});

describe('tabla campo → slice', () => {
  it('solo usa slices conocidos (o null = ya vigente)', () => {
    const validos = new Set([...Object.values(SLICES), null]);
    for (const [entidad, campos] of Object.entries(FIELD_SOURCES)) {
      for (const [campo, f] of Object.entries(campos)) {
        expect(validos.has(f.slice), `${entidad}.${campo}`).toBe(true);
        expect(f.hoy, `${entidad}.${campo}`).toBeTruthy();
      }
    }
  });

  it('los slices D, E, F, G, Task/Attempt, ContextPackage y daemon aparecen en alguna parte de la tabla o del catálogo', () => {
    const usados = new Set();
    for (const campos of Object.values(FIELD_SOURCES)) for (const f of Object.values(campos)) usados.add(f.slice);
    for (const d of Object.values(INTENTS)) usados.add(d.slice);
    for (const s of ['D', 'E', 'F', 'G', 'Task/Attempt', 'ContextPackage', 'daemon']) expect(usados.has(s), s).toBe(true);
  });

  it('undeclaredFields señala lo no declarado', () => {
    expect(undeclaredFields('Project', { id: 1, inventado: 2 })).toEqual(['inventado']);
    expect(undeclaredFields('Nada', {})[0]).toMatch(/sin declarar/);
  });
});
