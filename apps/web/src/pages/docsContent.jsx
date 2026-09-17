// docsContent.jsx — junta el contenido en español (docsContent.es.jsx) y en
// inglés (docsContent.en.jsx) con el índice (docsIndex.js) en un solo SECTIONS
// que DocsPage recorre; cada sección lleva Body.es y Body.en.
import { DOCS_INDEX } from './docsIndex';
import { CUERPOS as CUERPOS_ES } from './docsContent.es';
import { CUERPOS as CUERPOS_EN } from './docsContent.en';

export const SECTIONS = DOCS_INDEX.map((s) => ({
  ...s,
  Body: { es: CUERPOS_ES[s.id], en: CUERPOS_EN[s.id] },
}));
