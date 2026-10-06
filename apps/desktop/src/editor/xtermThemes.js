import { themeMode } from './themeMode';

export const XTERM_THEMES = {
  dark: {
    background: '#111111',
    foreground: '#DCDCD6',
    cursor: '#C6D66E',
    cursorAccent: '#111111',
    selectionBackground: 'rgba(198, 214, 110, 0.25)',
    black: '#1c1c1c', brightBlack: '#6b6b66',
    red: '#e5766b', brightRed: '#f09289',
    green: '#9fc46a', brightGreen: '#c6d66e',
    yellow: '#e2b85c', brightYellow: '#f0cd7c',
    blue: '#7aa7e0', brightBlue: '#9cc0ef',
    magenta: '#c39ae0', brightMagenta: '#d6b5ee',
    cyan: '#6fc2c0', brightCyan: '#92d8d5',
    white: '#dcdcd6', brightWhite: '#f5f5f0',
  },
  light: {
    background: '#f6f7ed',
    foreground: '#171717',
    cursor: '#171717',
    cursorAccent: '#f6f7ed',
    selectionBackground: 'rgba(23, 23, 23, 0.18)',
    black: '#2b2b28', brightBlack: '#6b6b66',
    red: '#b3362b', brightRed: '#cf4a3d',
    green: '#3f7a1f', brightGreen: '#4f9227',
    yellow: '#8a6200', brightYellow: '#a87700',
    blue: '#1f5fb0', brightBlue: '#2f76cc',
    magenta: '#8a3fb0', brightMagenta: '#a355cc',
    cyan: '#1a7a78', brightCyan: '#23918e',
    white: '#8a8a82', brightWhite: '#4a4a44',
  },
};

export const currentXtermTheme = () => XTERM_THEMES[themeMode()];
