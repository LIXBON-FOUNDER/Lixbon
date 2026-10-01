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
execFileSync('cargo', ['build', '--release', '--manifest-path', manifest, '--target', triple], { stdio: 'inherit' });

const ext = triple.includes('windows') ? '.exe' : '';
const out = join(root, 'src-tauri', 'binaries');
mkdirSync(out, { recursive: true });
copyFileSync(join(root, 'lxo', 'target', triple, 'release', `lxo${ext}`), join(out, `lxo-${triple}${ext}`));
console.log(`lxo → src-tauri/binaries/lxo-${triple}${ext}`);
