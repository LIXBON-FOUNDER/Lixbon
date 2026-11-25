import { describe, it, expect } from 'vitest';
import { iconoDeArchivo, extensionDeArchivo } from '@lixbon/icons/file-icons/resolver';
import { extOf } from './languages';
const extensions = { ts:'ts',tsx:'tsx',js:'js',jsx:'jsx',json:'json',md:'md',py:'py',java:'java',go:'go',rs:'rs',c:'c',h:'c',cpp:'cpp',cs:'cs',php:'php',rb:'rb',kt:'kt',swift:'swift',vue:'vue',html:'html',css:'css',scss:'css',sh:'sh',ps1:'sh',yml:'yaml',yaml:'yaml',sql:'sql',csv:'csv',png:'image',jpg:'image',webp:'image',svg:'svg',pdf:'pdf',txt:'txt',toml:'config',ini:'config' };
describe('iconos de archivo compartidos', () => {
  it.each(Object.entries(extensions))('%s reconoce el tipo %s', (ext, tipo) => expect(iconoDeArchivo(`src/archivo.${ext}`)).toBe(tipo));
  it.each([
    ['Dockerfile','docker'],['docker-compose.yml','docker'],['package.json','npm'],['package-lock.json','lock'],['yarn.lock','lock'],['.gitignore','git'],['.env.example','env'],['vite.config.ts','vite'],['LIXBON.md','lixbon'],['file.test.tsx','test'],['foo.spec.js','test'],['mystery.zz','unknown'],['README','unknown'],['C:\\src\\COMPONENT.TSX','tsx'],['nested.test.ts.lock','lock'],['.env.test.ts','env'],['vite.config.test.ts','vite'],
  ])('%s respeta nombre antes de pruebas y extensión', (name, tipo) => expect(iconoDeArchivo(name)).toBe(tipo));
  it('el editor comparte la extracción de extensión', () => {
    expect(extOf).toBe(extensionDeArchivo);
    expect(extOf('C:\\src\\index.TSX')).toBe('tsx');
    expect(extOf('Dockerfile')).toBe('');
  });
});
