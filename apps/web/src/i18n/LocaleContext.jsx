import { createContext, useContext, useEffect } from 'react';

export const SUPPORTED_LOCALES = ['es', 'en'];
export const DEFAULT_LOCALE = 'en';
// Idioma en el que se escriben los diccionarios: el respaldo si falta una clave.
export const SOURCE_LOCALE = 'es';

const LocaleContext = createContext(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}
