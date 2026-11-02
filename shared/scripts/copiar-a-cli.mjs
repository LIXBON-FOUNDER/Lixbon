// Copia a apps/cli/internal/weblogin/marca/ las fuentes e iconos que usa la página de login del CLI.
// go:embed no puede leer fuera del módulo de Go, así que el CLI lleva su propia copia.
// Uso (desde la raíz del repo): node shared/scripts/copiar-a-cli.mjs
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const shared = join(dirname(fileURLToPath(import.meta.url)), '..');
const destino = join(shared, '..', 'apps', 'cli', 'internal', 'weblogin', 'marca');

const FUENTES = [
  'sans/LixbonBrandSans-Regular.woff2',
  'sans/LixbonBrandSans-Medium.woff2',
  'sans/LixbonBrandSans-SemiBold.woff2',
  'serif/LixbonBrandSerif-Regular.woff2',
];
// Iconos de la página de login: añade aquí los que use.
const ICONOS = ['cli', 'hecho', 'alerta', 'candado', 'llave', 'navegador', 'terminal', 'externo'];

rmSync(destino, { recursive: true, force: true });
mkdirSync(join(destino, 'fonts'), { recursive: true });
mkdirSync(join(destino, 'icons'), { recursive: true });
for (const f of FUENTES) copyFileSync(join(shared, 'fonts', 'fonts', f), join(destino, 'fonts', f.split('/')[1]));
for (const id of ICONOS) copyFileSync(join(shared, 'icons', 'svg', 'linea', `${id}.svg`), join(destino, 'icons', `${id}.svg`));
copyFileSync(join(shared, 'fonts', 'OFL.txt'), join(destino, 'fonts', 'OFL.txt'));
console.log(`CLI: ${FUENTES.length} fuentes y ${ICONOS.length} iconos en ${destino}`);
