import { DOCS_INDEX } from './docsIndex';
import { CUERPOS as CUERPOS_ES } from './docsContent.es';
import { CUERPOS as CUERPOS_EN } from './docsContent.en';

export const SECTIONS = DOCS_INDEX.map((s) => ({
  ...s,
  Body: { es: CUERPOS_ES[s.id], en: CUERPOS_EN[s.id] },
}));
