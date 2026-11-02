// Genera native/iconos-native-datos.js a partir de svg/. Uso: node scripts/build-native.mjs
// React Native no tiene CSS: el relleno va con su color ya puesto (oscuro #FFFFFF, claro #000000).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (carpeta, id) => {
  const p = join(raiz, 'svg', carpeta, `${id}.svg`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined;
};

const datos = {};
for (const archivo of readdirSync(join(raiz, 'svg', 'linea')).sort()) {
  if (!archivo.endsWith('.svg')) continue;
  const id = archivo.slice(0, -4);
  const icono = { linea: leer('linea', id) };
  const oscuro = leer('relleno-oscuro', id);
  if (oscuro) {
    icono.oscuro = oscuro;
    icono.claro = leer('relleno-claro', id);
  }
  datos[id] = icono;
}

writeFileSync(
  join(raiz, 'native', 'iconos-native-datos.js'),
  `// Generado por scripts/build-native.mjs. No editar a mano.\nexport default ${JSON.stringify(datos, null, 1)};\n`,
);
console.log(`native: ${Object.keys(datos).length} iconos`);
