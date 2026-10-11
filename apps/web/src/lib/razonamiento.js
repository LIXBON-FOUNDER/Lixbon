// Nivel de razonamiento elegido en el chat y su traducción al `think` del gateway.
const CLAVE = 'lixbon.razonar';
const A_THINK = { auto: undefined, off: false, on: true, low: 'low', medium: 'medium', high: 'high' };

export function nivelesDe(info) {
  if (info?.reasoning === 'toggle') return ['auto', 'off', 'on'];
  if (info?.reasoning !== 'levels') return [];
  // gpt-oss no puede apagar el razonamiento.
  return /gpt-oss/i.test(info.real || '') ? ['auto', 'low', 'medium', 'high'] : ['auto', 'off', 'low', 'medium', 'high'];
}

export function thinkDe(valor, niveles) {
  return niveles.includes(valor) ? A_THINK[valor] : undefined;
}

export function leerRazonar() {
  try {
    return localStorage.getItem(CLAVE) || 'auto';
  } catch {
    return 'auto';
  }
}

export function guardarRazonar(valor) {
  try {
    localStorage.setItem(CLAVE, valor);
  } catch { /* sin almacenamiento */ }
}
