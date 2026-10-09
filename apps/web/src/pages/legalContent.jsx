import { LEGAL_INDEX } from './legalIndex';
import { CUERPOS as CUERPOS_ES } from './legalContent.es';
import { CUERPOS as CUERPOS_EN } from './legalContent.en';
import { VIGENCIA as VIGENCIA_POR_IDIOMA } from './legalShared';

export const LEGAL = LEGAL_INDEX.map((d) => ({
  ...d,
  Body: { es: CUERPOS_ES[d.id], en: CUERPOS_EN[d.id] },
}));

export const VIGENCIA = VIGENCIA_POR_IDIOMA;
