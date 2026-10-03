// orchTermSize.js — último tamaño que tuvo el PTY de cada tarea del
// orquestador. El remoto reproduce la salida con ese ancho: los agentes
// (Claude Code, Codex…) dibujan con el cursor y a otro ancho se descuadra.
export const DEFAULT_COLS = 120; // el que da Rust al abrir el PTY (orch/pty.rs)
export const ptyCols = new Map();
