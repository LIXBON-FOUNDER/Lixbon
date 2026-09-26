import { load } from '@tauri-apps/plugin-store';

const ARCHIVO = 'lixbon.settings.json';
const CLAVE = 'teamAcoplados';
const CLAVE_ABIERTO = 'teamAcopladoAbierto';

let almacen = null;
function abrir() {
  if (!almacen) almacen = load(ARCHIVO, { autoSave: true });
  return almacen;
}

export async function leerSeguidos() {
  try {
    const lista = await (await abrir()).get(CLAVE);
    return Array.isArray(lista) ? lista.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function guardarSeguidos(ids) {
  try {
    await (await abrir()).set(CLAVE, ids);
  } catch { /* sin almacén: la elección dura lo que la sesión */ }
}

export async function leerAbierto() {
  try {
    return (await (await abrir()).get(CLAVE_ABIERTO)) || '';
  } catch {
    return '';
  }
}

export async function guardarAbierto(canalId) {
  try {
    await (await abrir()).set(CLAVE_ABIERTO, canalId || '');
  } catch { /* igual que arriba */ }
}
