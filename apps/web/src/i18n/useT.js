// Si falta la clave cae al español y, si tampoco existe, devuelve la clave.
import { useCallback } from 'react';
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
  // Estable entre renders: hay efectos con `t` en sus dependencias (Facturación)
  // y una función nueva en cada render los repetía sin fin.
  return useCallback((key, vars) => {
    const value = lookup(dict[locale], key) ?? lookup(dict[SOURCE_LOCALE], key) ?? key;
    return interpolate(value, vars);
  }, [dict, locale]);
}
