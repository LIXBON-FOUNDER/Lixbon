// LocaleContext.jsx — idioma activo (es/en), determinado por el prefijo /en de la URL.
import { createContext, useContext, useEffect } from 'react';

export const SUPPORTED_LOCALES = ['es', 'en'];
export const DEFAULT_LOCALE = 'es';

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
