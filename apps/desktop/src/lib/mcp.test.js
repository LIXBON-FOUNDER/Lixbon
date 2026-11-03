import { describe, expect, it } from 'vitest';
import { joinCommandLine, splitCommandLine } from './mcp';

describe('joinCommandLine', () => {
  it('deja tal cual los argumentos simples y entrecomilla los que llevan espacios', () => {
    expect(joinCommandLine({ command: 'npx', args: ['-y', '@a/b', 'con espacios'] }))
      .toBe('npx -y @a/b "con espacios"');
  });

  it('un argumento vacío se escribe como ""', () => {
    expect(joinCommandLine({ command: 'x', args: [''] })).toBe('x ""');
  });

  // Lo que se muestra en Ajustes y se vuelve a leer al guardar tiene que dar lo mismo.
  it.each([
    ['simple'],
    ['con espacios'],
    ['dice "hola"'],
    ['solo"comilla'],
    ["it's"],
    ["it's \"mixto\""],
    ['C:\\ruta\\con barra\\'],
    ['C:\\ruta\\'],
    ['termina en barra\\'],
    ['a\\"b'],
    [''],
    ['{"json":"valor","n":1}'],
  ])('ida y vuelta: %j', (arg) => {
    const spec = { command: 'cmd', args: ['--flag', arg, 'fin'] };
    expect(splitCommandLine(joinCommandLine(spec))).toEqual(['cmd', '--flag', arg, 'fin']);
  });
});
