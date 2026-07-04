import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';

export function useTheme() {
  const { theme, accentColor, terminalFontSize, terminalFontFamily } = useAppStore();

  useEffect(() => {
    const root = document.documentElement;

    // Aplicar Modo Claro / Oscuro
    if (theme === 'light') {
      root.classList.add('light-theme');
    } else {
      root.classList.remove('light-theme');
    }

    // Aplicar Color Accent
    root.style.setProperty('--accent', accentColor);
    
    // Convertir color HEX a RGB para efectos de opacidad/sombras en CSS
    const r = parseInt(accentColor.slice(1, 3), 16);
    const g = parseInt(accentColor.slice(3, 5), 16);
    const b = parseInt(accentColor.slice(5, 7), 16);
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

    // Aplicar Fuente y tamaño de terminal
    root.style.setProperty('--font-size-terminal', `${terminalFontSize}px`);
    root.style.setProperty('--font-mono', `'${terminalFontFamily}', monospace`);
  }, [theme, accentColor, terminalFontSize, terminalFontFamily]);
}
