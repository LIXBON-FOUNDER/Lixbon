// uiScale.js — tamaño de toda la interfaz. Es el zoom del WebView (como Ctrl+
// en un navegador), no un font-size: así crece todo a la vez y las medidas
// en px del CSS siguen cuadrando. El IDE y la ventana de Team comparten
// origen, así que comparten también la clave de localStorage.
import { getCurrentWebview } from '@tauri-apps/api/webview';

const KEY = 'lx_ui_scale';
export const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.4];
export const DEFAULT_UI_SCALE = 1.1;

export function readUiScale() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return UI_SCALES.includes(v) ? v : DEFAULT_UI_SCALE;
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

async function apply(scale) {
  try { await getCurrentWebview().setZoom(scale); } catch { /* fuera de Tauri */ }
  window.dispatchEvent(new CustomEvent('lixbon:ui-scale', { detail: scale }));
}

export function setUiScale(scale) {
  const v = UI_SCALES.includes(scale) ? scale : DEFAULT_UI_SCALE;
  try { localStorage.setItem(KEY, String(v)); } catch { /* sin almacenamiento */ }
  apply(v);
}

export function stepUiScale(dir) {
  if (dir === 0) return setUiScale(DEFAULT_UI_SCALE);
  const i = UI_SCALES.indexOf(readUiScale());
  setUiScale(UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, i + dir))]);
}

export function initUiScale() {
  apply(readUiScale());
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(readUiScale()); });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
    const dir = e.key === '+' || e.key === '=' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 0 : null;
    if (dir === null) return;
    e.preventDefault();
    stepUiScale(dir);
  });
}
