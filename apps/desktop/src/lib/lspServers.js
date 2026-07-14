// lspServers.js — qué servidor de lenguaje usar para cada archivo y cómo
// instalarlo solo.
//
// La inteligencia de código (autocompletado real, ir a definición, hover) no
// vive en las extensiones de VSCode: vive en su servidor, que habla LSP, un
// protocolo abierto. Aquí solo declaramos cómo conseguir y arrancar cada uno.
//
// Cada servidor lleva:
//   bin     — nombre del ejecutable (lo resuelve Rust: app-data → PATH)
//   args    — argumentos de arranque
//   install — receta automática, o null si hay que instalarlo a mano
//   manual  — comando que se le enseña al usuario cuando no hay receta
//   needs   — prerequisito del sistema, para poder explicarlo si falla

const IS_WINDOWS = navigator.userAgent.includes('Windows');

/** id de lenguaje LSP a partir del nombre de archivo (los ids son estándar). */
export function lspLanguageId(fileName) {
  const lower = (fileName || '').toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const ext = lower.split('.').pop() || '';
  return {
    py: 'python', pyi: 'python',
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
    rs: 'rust',
    go: 'go',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    json: 'json', jsonc: 'jsonc',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    yml: 'yaml', yaml: 'yaml',
  }[ext] || '';
}

const PYRIGHT = {
  id: 'pyright',
  label: 'Pyright (Python)',
  bin: 'pyright-langserver',
  args: ['--stdio'],
  install: { kind: 'npm', package: 'pyright' },
  needs: 'Node.js',
};

const TS_SERVER = {
  id: 'typescript-language-server',
  label: 'TypeScript / JavaScript',
  bin: 'typescript-language-server',
  args: ['--stdio'],
  install: { kind: 'npm', package: 'typescript-language-server typescript' },
  needs: 'Node.js',
};

// rust-analyzer se publica como binario suelto para Windows; en macOS/Linux el
// release es .gz (no .zip), así que allí se instala con rustup.
const RUST_ANALYZER = {
  id: 'rust-analyzer',
  label: 'rust-analyzer',
  bin: 'rust-analyzer',
  args: [],
  install: IS_WINDOWS
    ? {
        kind: 'archive',
        url: 'https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-pc-windows-msvc.zip',
      }
    : null,
  manual: 'rustup component add rust-analyzer',
};

const GOPLS = {
  id: 'gopls',
  label: 'gopls (Go)',
  bin: 'gopls',
  args: [],
  install: null, // se compila con la toolchain de Go; no hay binario suelto
  manual: 'go install golang.org/x/tools/gopls@latest',
  needs: 'Go',
};

const CLANGD = {
  id: 'clangd',
  label: 'clangd (C / C++)',
  bin: 'clangd',
  args: [],
  install: null, // el nombre del release lleva versión: no hay URL estable
  manual: 'Instala LLVM/clangd y añádelo al PATH',
};

// vscode-langservers-extracted saca los servidores de JSON/HTML/CSS del propio
// VSCode y los publica sueltos: los mismos servidores, sin extension host.
const EXTRACTED = { kind: 'npm', package: 'vscode-langservers-extracted' };

const JSON_SERVER = {
  id: 'vscode-json',
  label: 'JSON',
  bin: 'vscode-json-language-server',
  args: ['--stdio'],
  install: EXTRACTED,
  needs: 'Node.js',
};

const CSS_SERVER = {
  id: 'vscode-css',
  label: 'CSS / SCSS / LESS',
  bin: 'vscode-css-language-server',
  args: ['--stdio'],
  install: EXTRACTED,
  needs: 'Node.js',
};

const HTML_SERVER = {
  id: 'vscode-html',
  label: 'HTML',
  bin: 'vscode-html-language-server',
  args: ['--stdio'],
  install: EXTRACTED,
  needs: 'Node.js',
};

const YAML_SERVER = {
  id: 'yaml',
  label: 'YAML',
  bin: 'yaml-language-server',
  args: ['--stdio'],
  install: { kind: 'npm', package: 'yaml-language-server' },
  needs: 'Node.js',
};

/** Todos los servidores conocidos, sin repetir (uno sirve a varios lenguajes). */
export const ALL_SERVERS = [
  PYRIGHT, TS_SERVER, RUST_ANALYZER, GOPLS, CLANGD,
  JSON_SERVER, CSS_SERVER, HTML_SERVER, YAML_SERVER,
];

/** lenguaje LSP → candidatos, en orden de preferencia. */
const BY_LANGUAGE = {
  python: [PYRIGHT],
  typescript: [TS_SERVER],
  typescriptreact: [TS_SERVER],
  javascript: [TS_SERVER],
  javascriptreact: [TS_SERVER],
  rust: [RUST_ANALYZER],
  go: [GOPLS],
  c: [CLANGD],
  cpp: [CLANGD],
  json: [JSON_SERVER],
  jsonc: [JSON_SERVER],
  css: [CSS_SERVER],
  scss: [CSS_SERVER],
  less: [CSS_SERVER],
  html: [HTML_SERVER],
  yaml: [YAML_SERVER],
};

/** Candidatos para un archivo. [] si el lenguaje no tiene servidor conocido. */
export function serversFor(fileName) {
  return BY_LANGUAGE[lspLanguageId(fileName)] || [];
}

export function serverById(id) {
  return ALL_SERVERS.find((s) => s.id === id) || null;
}
