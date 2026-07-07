// runConfigs.js — detección del tipo de proyecto para los botones Run/Build.
// Recibe las entradas del root del workspace (readDir) y devuelve los comandos.

/**
 * @param {{name:string, is_dir:boolean}[]} entries  entradas del root
 * @returns {{ label:string, run?:string, build?:string } | null}
 */
export function detectRunConfig(entries) {
  const names = new Set((entries || []).map((e) => e.name));
  const has = (n) => names.has(n);
  const anyExt = (ext) => (entries || []).some((e) => !e.is_dir && e.name.toLowerCase().endsWith(ext));

  if (has('package.json')) {
    return { label: 'Node', run: 'npm run dev', build: 'npm run build' };
  }
  if (has('Cargo.toml')) {
    return { label: 'Rust', run: 'cargo run', build: 'cargo build' };
  }
  if (has('go.mod')) {
    return { label: 'Go', run: 'go run .', build: 'go build ./...' };
  }
  if (has('pyproject.toml') || has('requirements.txt') || anyExt('.py')) {
    const main = has('main.py') ? 'main.py' : has('app.py') ? 'app.py' : 'main.py';
    return { label: 'Python', run: `python ${main}` };
  }
  if (has('Makefile') || has('makefile')) {
    return { label: 'Make', run: 'make', build: 'make build' };
  }
  if (has('CMakeLists.txt')) {
    return { label: 'CMake', build: 'cmake --build build' };
  }
  return null;
}
