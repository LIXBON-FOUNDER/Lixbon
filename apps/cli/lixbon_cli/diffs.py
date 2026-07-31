"""Gestión visual de cambios de código: acción `┃ editó ruta +N -M` y diff.

El diff se dibuja como en un editor: número de línea, signo y la fila entera
con fondo (verde lo añadido, rojo lo eliminado). Es la única parte del registro
de trabajo con color de fondo, y por eso se localiza al vuelo entre decenas de
líneas de acciones.
"""
import difflib
from dataclasses import dataclass
from pathlib import Path

from lixbon_cli.term import g
from lixbon_cli.theme import PALETTE
from lixbon_cli.ui import KIND_VERB, rail, render_action

# Líneas iguales que se muestran alrededor de cada cambio. Con menos se pierde
# el sitio; con más, un cambio de una línea arrastra media pantalla.
DIFF_CONTEXT = 3
DIFF_MAX_ROWS = 44
NUM_MIN_WIDTH = 3


@dataclass
class FileChange:
    kind: str          # create | update | delete | rename | mkdir | command | append
    path: str
    old_text: str = ""
    new_text: str = ""
    detail: str = ""   # destino de rename, comando de run_command, etc.

    @property
    def verb(self) -> str:
        return KIND_VERB.get(self.kind, self.kind)


def compute_change(workspace: Path, tool_name: str, args: dict, resolve_path) -> FileChange | None:
    """Describe el efecto de un tool ANTES de ejecutarlo (para aprobar con contexto).

    Devuelve None para herramientas de solo lectura (no requieren aprobación).
    """
    rel = args.get("path", "")
    if tool_name in ("write_file", "append_file"):
        new_content = args.get("content", "")
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.exists() else None
        except Exception:
            old = None
        if tool_name == "append_file":
            return FileChange("append", rel, old or "", (old or "") + new_content)
        if old is None:
            return FileChange("create", rel, "", new_content)
        return FileChange("update", rel, old, new_content)
    if tool_name == "edit_file":
        old_frag = args.get("old_text", "")
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
        except Exception:
            old = ""
        if not old or not old_frag or old_frag not in old:
            # El error real (no encontrado / ambiguo) saldrá al ejecutar
            return FileChange("update", rel, old, old)
        new = (old.replace(old_frag, args.get("new_text", ""))
               if args.get("all") else old.replace(old_frag, args.get("new_text", ""), 1))
        return FileChange("update", rel, old, new)
    if tool_name == "delete_file":
        try:
            target = resolve_path(workspace, rel)
            old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
        except Exception:
            old = ""
        return FileChange("delete", rel, old, "")
    if tool_name == "rename_file":
        return FileChange("rename", args.get("src", ""), detail=args.get("dst", ""))
    if tool_name == "mkdir":
        return FileChange("mkdir", rel)
    if tool_name == "run_command":
        return FileChange("command", "", detail=args.get("command", ""))
    return None  # list_files, read_file, search: solo lectura


# ── Cálculo de filas ────────────────────────────────────────────────────────

def diff_rows(change: FileChange, context: int = DIFF_CONTEXT) -> list[tuple[str, int, int, str]]:
    """Filas `(clase, nº antiguo, nº nuevo, texto)` listas para pintar.

    Se usa SequenceMatcher y no `unified_diff` porque este último devuelve
    texto ya formateado y PIERDE los números de línea, que son justo lo que
    permite situar el cambio dentro del archivo.

    Clases: `ctx` (contexto), `del`, `add` y `gap` (tramo igual omitido).
    """
    old = change.old_text.splitlines()
    new = change.new_text.splitlines()
    opcodes = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
    rows: list[tuple[str, int, int, str]] = []

    for index, (tag, i1, i2, j1, j2) in enumerate(opcodes):
        if tag == "equal":
            total = i2 - i1
            last = index == len(opcodes) - 1
            head = 0 if index == 0 else context
            tail = 0 if last else context
            # Saltar una sola línea no ahorra nada y cuesta un `…`: se muestra.
            if total > head + tail + 1:
                for k in range(head):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
                # El `…` solo tiene sentido ENTRE dos tramos visibles: al abrir
                # (sin filas todavía) o al cerrar el diff no informa de nada.
                if rows and not last:
                    rows.append(("gap", 0, 0, ""))
                for k in range(total - tail, total):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
            else:
                for k in range(total):
                    rows.append(("ctx", i1 + k + 1, j1 + k + 1, old[i1 + k]))
            continue
        for k in range(i1, i2):
            rows.append(("del", k + 1, 0, old[k]))
        for k in range(j1, j2):
            rows.append(("add", 0, k + 1, new[k]))
    return rows


def diff_counts(change: FileChange) -> tuple[int, int]:
    """Líneas añadidas y eliminadas."""
    old = change.old_text.splitlines()
    new = change.new_text.splitlines()
    adds = dels = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag != "equal":
            dels += i2 - i1
            adds += j2 - j1
    return adds, dels


# ── Pintado ─────────────────────────────────────────────────────────────────

def render_change(console, change: FileChange, max_rows: int = DIFF_MAX_ROWS) -> None:
    """Imprime la acción (`┃ editó  ruta  +12 -3`) y el diff con números."""
    if change.kind == "command":
        render_action(console, change.verb, change.detail)
        return
    if change.kind == "rename":
        render_action(console, change.verb, f"{change.path} {g('arrow')} {change.detail}")
        return
    if change.kind == "mkdir":
        render_action(console, change.verb, change.path)
        return

    adds, dels = diff_counts(change)
    render_action(console, change.verb, change.path, adds=adds, dels=dels)
    render_diff(console, diff_rows(change), max_rows=max_rows)


def render_diff(console, rows: list[tuple[str, int, int, str]],
                max_rows: int = DIFF_MAX_ROWS) -> None:
    """Pinta las filas de un diff dentro del canal del registro de trabajo."""
    from rich.cells import set_cell_size
    from rich.text import Text

    from lixbon_cli.theme import PAD_LEFT, PAD_RIGHT

    if not rows:
        return
    numbers = [max(old_no, new_no) for _, old_no, new_no, _ in rows]
    num_width = max(NUM_MIN_WIDTH, len(str(max(numbers) if numbers else 0)))
    # El canal se come dos columnas; el resto es la fila coloreada, que llega
    # hasta el margen derecho para que el fondo forme un bloque limpio.
    width = max(20, console.width - PAD_LEFT - PAD_RIGHT - 2)
    code_width = max(8, width - num_width - 2)

    shown = rows[:max_rows]
    for kind, old_no, new_no, text in shown:
        if kind == "gap":
            console.print(f"{rail()}[lx.dim2]{' ' * (num_width + 2)}{g('ellipsis')}[/]")
            continue
        if kind == "add":
            back, sign, sign_fg = PALETTE["diff_add_bg"], "+", PALETTE["diff_add_fg"]
        elif kind == "del":
            back, sign, sign_fg = PALETTE["diff_del_bg"], "-", PALETTE["diff_del_fg"]
        else:
            back, sign, sign_fg = "", " ", PALETTE["dim2"]

        number = str(new_no or old_no)
        # Los tabuladores descuadran el bloque de color: el fondo se pinta por
        # celdas y la terminal expande el tabulador a un ancho que rich no sabe.
        body = set_cell_size(text.replace("\t", "    "), code_width)
        on = f" on {back}" if back else ""

        line = Text()
        line.append(g("rail") + " ", style=PALETTE["dim2"])
        line.append(f"{number:>{num_width}} ", style=f"{PALETTE['dim2']}{on}")
        line.append(sign, style=f"{sign_fg}{on}")
        line.append(body, style=f"{PALETTE['cream'] if back else PALETTE['dim']}{on}")
        console.print(line)

    if len(rows) > max_rows:
        console.print(
            f"{rail()}[lx.dim2]{' ' * (num_width + 2)}"
            f"{g('ellipsis')} {len(rows) - max_rows} líneas más[/]"
        )
