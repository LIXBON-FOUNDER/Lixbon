// theme.js — el IDE es solo oscuro; se conserva la API para los módulos que
// consultan el modo (terminal, editor).
export function getTheme() {
  return 'dark';
}

export function useTheme() {
  return ['dark', () => {}];
}
