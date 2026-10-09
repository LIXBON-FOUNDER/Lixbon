// Si falta la clave cae al español y, si tampoco existe, devuelve la clave.
import { useLocale } from './LocaleContext';
import { DICTIONARIES } from './dictionaries';
import { SOURCE_LOCALE } from './LocaleContext';

function lookup(obj, path) {
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

function interpolate(value, vars) {
  if (typeof value !== 'string' || !vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

export function useT(namespace) {
  const locale = useLocale();
  const dict = DICTIONARIES[namespace];
  if (!dict && import.meta.env.DEV) {
    throw new Error(`useT: namespace desconocido "${namespace}"`);
  }
  return (key, vars) => {
    const value = lookup(dict[locale], key) ?? lookup(dict[SOURCE_LOCALE], key) ?? key;
    return interpolate(value, vars);
  };
}
