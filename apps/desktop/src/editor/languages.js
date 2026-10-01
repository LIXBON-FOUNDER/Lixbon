// languages.js — lenguaje de CodeMirror por extensión. Se cargan bajo demanda
// para no meter todos los parsers en el arranque.
const LOADERS = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  svelte: () => import('@codemirror/lang-html').then((m) => m.html()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
};

const LABELS = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript JSX', ts: 'TypeScript',
  tsx: 'TypeScript JSX', css: 'CSS', scss: 'SCSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  json: 'JSON', md: 'Markdown', py: 'Python', rs: 'Rust', sql: 'SQL', yml: 'YAML', yaml: 'YAML',
  toml: 'TOML', sh: 'Shell', go: 'Go', java: 'Java', c: 'C', cpp: 'C++', h: 'C',
};

export const extOf = (path) => (path.split(/[\\/]/).pop().split('.').slice(1).pop() || '').toLowerCase();

export function loadLanguage(path) {
  const loader = LOADERS[extOf(path)];
  return loader ? loader() : Promise.resolve(null);
}

export function languageLabel(path) {
  return LABELS[extOf(path)] || 'Texto plano';
}
