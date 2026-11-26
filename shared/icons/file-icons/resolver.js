export const extensionDeArchivo = (nombre = '') => (nombre.split(/[\\/]/).pop().split('.').slice(1).pop() || '').toLowerCase();
const TIPOS = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  json: 'json', md: 'md', mdx: 'md', py: 'py', java: 'java', go: 'go', rs: 'rs', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'cs', php: 'php', rb: 'rb', kt: 'kt', kts: 'kt',
  swift: 'swift', vue: 'vue', html: 'html', htm: 'html', css: 'css', scss: 'css', sass: 'css',
  sh: 'sh', bash: 'sh', ps1: 'sh', yml: 'yaml', yaml: 'yaml', sql: 'sql', csv: 'csv',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'svg', pdf: 'pdf',
  txt: 'txt', toml: 'config', ini: 'config', lock: 'lock',
};
export function iconoDeArchivo(nombre = '') {
  const base = nombre.split(/[\\/]/).pop().toLowerCase();
  if (base === 'dockerfile' || base === 'docker-compose.yml' || base === 'docker-compose.yaml') return 'docker';
  if (base === 'package.json') return 'npm';
  if (base === 'package-lock.json' || base.endsWith('.lock')) return 'lock';
  if (base === '.gitignore') return 'git';
  if (base.startsWith('.env')) return 'env';
  if (/^vite\.config\./.test(base)) return 'vite';
  if (base === 'lixbon.md') return 'lixbon';
  if (/\.(test|spec)\./.test(base)) return 'test';
  return TIPOS[extensionDeArchivo(base)] || 'unknown';
}
