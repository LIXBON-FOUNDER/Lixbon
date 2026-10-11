// razonamiento.js — mismo criterio que la web (apps/web/src/lib/razonamiento.js):
// el gateway publica `reasoning: toggle|levels` en /v1/models y «auto» deja que
// decida él según el mensaje.
const A_THINK = { auto: undefined, off: false, on: true, low: 'low', medium: 'medium', high: 'high' };

export const ETIQUETA_RAZONAR = { auto: 'Auto', off: 'Apagado', on: 'Encendido', low: 'Bajo', medium: 'Medio', high: 'Alto' };

export function nivelesDe(info) {
  if (info?.reasoning === 'toggle') return ['auto', 'off', 'on'];
  if (info?.reasoning !== 'levels') return [];
  // gpt-oss no puede apagar el razonamiento.
  return /gpt-oss/i.test(info.real || '') ? ['auto', 'low', 'medium', 'high'] : ['auto', 'off', 'low', 'medium', 'high'];
}

export function thinkDe(valor, niveles) {
  return niveles.includes(valor) ? A_THINK[valor] : undefined;
}
