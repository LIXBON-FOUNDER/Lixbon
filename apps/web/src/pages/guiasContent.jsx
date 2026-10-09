import { GUIAS_INDEX } from './guiasIndex';
import { CUERPOS as CUERPOS_ES } from './guiasContent.es';
import { CUERPOS as CUERPOS_EN } from './guiasContent.en';

export const GUIAS = GUIAS_INDEX.map((g) => ({
  ...g,
  Body: { es: CUERPOS_ES[g.id], en: CUERPOS_EN[g.id] },
}));
