// orchTermSize.js — último tamaño que tuvo el PTY de cada tarea del
// orquestador. El remoto reproduce la salida con ese ancho: los agentes
// (Claude Code, Codex…) dibujan con el cursor y a otro ancho se descuadra.
export const DEFAULT_COLS = 120; // el que da Rust al abrir el PTY (orch/pty.rs)
export const ptyCols = new Map();

// Ancho mínimo del PTY de un agente. ConPTY parte las líneas largas y por
// debajo de 76 columnas corrompe el bloque base64 del informe; con 200 hay
// margen. Si el panel es más estrecho se encoge la vista (scroll horizontal),
// nunca el PTY.
export const ORCH_PTY_MIN_COLS = 200;

// Tamaño que se manda a orch_term_resize a partir de lo que cabe en el panel.
// Las filas siguen la altura del panel; las columnas nunca bajan del mínimo.
export function computePtySize(panelCols, panelRows) {
  const cols = Number.isFinite(panelCols) ? Math.floor(panelCols) : 0;
  const rows = Number.isFinite(panelRows) && panelRows >= 1 ? Math.floor(panelRows) : 1;
  return { cols: Math.max(ORCH_PTY_MIN_COLS, cols), rows };
}