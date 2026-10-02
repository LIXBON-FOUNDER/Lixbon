// Compila `lxo` y lo deja donde Tauri espera los sidecars (externalBin):
// src-tauri/binaries/lxo-<target-triple>[.exe]. Tauri lo copia junto al
// ejecutable de Lixbon, en dev y en el instalador.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = process.env.TAURI_ENV_TARGET_TRIPLE
  || /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!triple) throw new Error('No se pudo averiguar el target de Rust (rustc -vV)');

const manifest = join(root, 'lxo', 'Cargo.toml');
const out = join(root, 'src-tauri', 'binaries');
mkdirSync(out, { recursive: true });

const compilar = (t) => {
  execFileSync('cargo', ['build', '--release', '--manifest-path', manifest, '--target', t], { stdio: 'inherit' });
  return join(root, 'lxo', 'target', t, 'release', `lxo${t.includes('windows') ? '.exe' : ''}`);
};

if (triple === 'universal-apple-darwin') {
  // Build universal de macOS: Tauri pide un sidecar `lxo-universal-apple-darwin`
  // (y uno por arquitectura); se compila cada una y se fusionan con lipo.
  const arm = compilar('aarch64-apple-darwin');
  const intel = compilar('x86_64-apple-darwin');
  copyFileSync(arm, join(out, 'lxo-aarch64-apple-darwin'));
  copyFileSync(intel, join(out, 'lxo-x86_64-apple-darwin'));
  execFileSync('lipo', ['-create', '-output', join(out, 'lxo-universal-apple-darwin'), arm, intel]);
  console.log('lxo → src-tauri/binaries/lxo-universal-apple-darwin');
} else {
  const ext = triple.includes('windows') ? '.exe' : '';
  copyFileSync(compilar(triple), join(out, `lxo-${triple}${ext}`));
  console.log(`lxo → src-tauri/binaries/lxo-${triple}${ext}`);
}
