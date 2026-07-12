"""Gestión visual de cambios de código: resúmenes ● Update(...) +N -M y diffs."""
import difflib
from dataclasses import dataclass
from pathlib import Path

from lixbon_cli.term import g


@dataclass
class FileChange:
    kind: str          # create | update | delete | rename | mkdir | command | append
    path: str
    old_text: str = ""
    new_text: str = ""
    detail: str = ""   # destino de rename, comando de run_command, etc.

    @property
    def verb(self) -> str:
        return {
            "create": "Create",
            "update": "Update",
            "delete": "Delete",
            "rename": "Rename",
            "mkdir": "Mkdir",
            "append": "Append",
            "command": "Run",
        }.get(self.kind, self.kind.title())


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


def diff_counts(change: FileChange) -> tuple[int, int]:
    adds = dels = 0
    for line in _unified(change):
        if line.startswith("+") and not line.startswith("+++"):
            adds += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    return adds, dels


def _unified(change: FileChange) -> list[str]:
    return list(difflib.unified_diff(
        change.old_text.splitlines(),
        change.new_text.splitlines(),
        fromfile=f"{change.path} (antes)",
        tofile=f"{change.path} (ahora)",
        lineterm="",
        n=2,
    ))


def render_change(console, change: FileChange, max_lines: int = 40) -> None:
    """Imprime `● Update(ruta) +12 -3` y el diff coloreado truncado."""
    dot = g("dot")
    if change.kind == "command":
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]Run[/][lx.dim]([/][lx.beige]{_escape(change.detail)}[/][lx.dim])[/]")
        return
    if change.kind == "rename":
        console.print(
            f"[lx.accent2]{dot}[/] [bold lx.primary]Rename[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/]"
            f"[lx.dim] {g('arrow')} [/][lx.beige]{_escape(change.detail)}[/][lx.dim])[/]"
        )
        return
    if change.kind == "mkdir":
        console.print(f"[lx.accent2]{dot}[/] [bold lx.primary]Mkdir[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/][lx.dim])[/]")
        return

    adds, dels = diff_counts(change)
    summary = f"[lx.accent2]{dot}[/] [bold lx.primary]{change.verb}[/][lx.dim]([/][lx.beige]{_escape(change.path)}[/][lx.dim])[/]"
    if adds or dels:
        summary += f"  [lx.diff.add]+{adds}[/] [lx.diff.del]-{dels}[/]"
    console.print(summary)

    lines = _unified(change)
    if not lines:
        return
    shown = lines[:max_lines]
    for line in shown:
        if line.startswith("+++") or line.startswith("---"):
            console.print(f"  [lx.dim]{_escape(line)}[/]")
        elif line.startswith("@@"):
            console.print(f"  [lx.diff.hunk]{_escape(line)}[/]")
        elif line.startswith("+"):
            console.print(f"  [lx.diff.add]{_escape(line)}[/]")
        elif line.startswith("-"):
            console.print(f"  [lx.diff.del]{_escape(line)}[/]")
        else:
            console.print(f"  [lx.dim]{_escape(line)}[/]")
    if len(lines) > max_lines:
        console.print(f"  [lx.dim2]{g('ellipsis')} +{len(lines) - max_lines} líneas más[/]")


def _escape(line: str) -> str:
    return line.replace("[", "\\[")
