#!/usr/bin/env python3
"""Genera apps/cli/client_cli.py concatenando los módulos de lixbon_cli/.

La distribución del CLI es UN solo archivo servido por el gateway en
GET /install/client_cli.py; el código se mantiene modular aquí y este script
lo aplana. Reglas para los módulos:

- Imports internos siempre absolutos y de una forma: `from lixbon_cli.x import y`
  (se eliminan al concatenar; los nombres quedan en el namespace global).
- Prohibido `from lixbon_cli.x import y as z` (el alias quedaría sin definir).
- Nombres top-level únicos entre módulos (se valida con ast).
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parent
PKG_DIR = CLI_DIR / "lixbon_cli"
OUTPUT = CLI_DIR / "client_cli.py"

# Orden de concatenación (dependencias de código a nivel de módulo primero)
MODULE_ORDER = [
    "term",
    "theme",
    "config",
    "sse",
    "api",
    "inputq",
    "ui",
    "diffs",
    "clipboard",
    "remote",
    "context",
    "agent",
    "sessions",
    "commands",
    "app",
    "cli",
]

BANNER = '''#!/usr/bin/env python3
# ============================================================================
#  lixbon CLI — GENERADO por apps/cli/build.py. NO EDITAR A MANO.
#  Fuente: apps/cli/lixbon_cli/*.py  |  Regenerar: python apps/cli/build.py
# ============================================================================
'''

_INTERNAL_IMPORT = re.compile(r"^\s*(from|import)\s+lixbon_cli(\.|\s|$)")
_ALIAS_IMPORT = re.compile(r"^\s*from\s+lixbon_cli\S*\s+import\s+.*\bas\b")


def strip_internal_imports(source: str, module: str) -> str:
    out: list[str] = []
    lines = source.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if _ALIAS_IMPORT.match(line):
            raise SystemExit(f"[build] {module}.py: import interno con alias no soportado: {line.strip()}")
        if _INTERNAL_IMPORT.match(line):
            # Import interno; si es multilínea con paréntesis, saltar hasta el cierre
            if "(" in line and ")" not in line:
                while i < len(lines) and ")" not in lines[i]:
                    i += 1
            i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def toplevel_names(source: str, module: str) -> set[str]:
    tree = ast.parse(source)
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def generate() -> str:
    parts = [BANNER]
    seen: dict[str, str] = {}
    for module in MODULE_ORDER:
        path = PKG_DIR / f"{module}.py"
        source = path.read_text(encoding="utf-8")
        stripped = strip_internal_imports(source, module)
        for name in toplevel_names(stripped, module):
            if name in seen:
                raise SystemExit(
                    f"[build] Nombre top-level duplicado '{name}' en {module}.py (ya definido en {seen[name]}.py)"
                )
            seen[name] = module
        parts.append(
            f"\n# {'─' * 74}\n# módulo: lixbon_cli/{module}.py\n# {'─' * 74}\n"
        )
        parts.append(stripped.rstrip() + "\n")
    parts.append(
        '\n\nif __name__ == "__main__":\n    sys.exit(main())\n'
    )
    combined = "".join(parts)
    ast.parse(combined)  # validación final de sintaxis
    return combined


def main() -> int:
    combined = generate()
    OUTPUT.write_text(combined, encoding="utf-8", newline="\n")
    print(f"[build] {OUTPUT} generado ({len(combined.splitlines())} líneas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
