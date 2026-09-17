// legalContent.jsx — junta el contenido en español (legalContent.es.jsx) y en
// inglés (legalContent.en.jsx) con el índice (legalIndex.js); cada documento
// lleva Body.es y Body.en. RESPONSABLE y VIGENCIA viven en legalShared.js.
import { LEGAL_INDEX } from './legalIndex';
import { CUERPOS as CUERPOS_ES } from './legalContent.es';
import { CUERPOS as CUERPOS_EN } from './legalContent.en';
import { VIGENCIA as VIGENCIA_POR_IDIOMA } from './legalShared';

export const LEGAL = LEGAL_INDEX.map((d) => ({
  ...d,
  Body: { es: CUERPOS_ES[d.id], en: CUERPOS_EN[d.id] },
}));

export const VIGENCIA = VIGENCIA_POR_IDIOMA;
