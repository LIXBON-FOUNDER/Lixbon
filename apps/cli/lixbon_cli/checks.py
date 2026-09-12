"""Verificación automática tras editar: el linter o compilador del proyecto
sobre el archivo tocado, para que el modelo vea el error en el mismo paso y
lo corrija, en vez de enterarse (o no) al correr los tests."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CHECK_TIMEOUT = 20
MAX_CHECK_CHARS = 2500


def _run_check(cmd: list[str], cwd: Path) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=CHECK_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return -1, f"(no se pudo verificar: {exc})"
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def _node_bin(workspace: Path, name: str) -> str | None:
    exe = workspace / "node_modules" / ".bin" / (f"{name}.cmd" if os.name == "nt" else name)
    return str(exe) if exe.exists() else None


def _check_python(workspace: Path, path: Path) -> tuple[str, str]:
    if shutil.which("ruff"):
        code, out = _run_check(["ruff", "check", "--no-fix", "--output-format", "concise", str(path)], workspace)
        return "ruff", "" if code == 0 else out
    code, out = _run_check([sys.executable, "-m", "py_compile", str(path)], workspace)
    return "py_compile", "" if code == 0 else out


def _check_js(workspace: Path, path: Path) -> tuple[str, str]:
    eslint = _node_bin(workspace, "eslint")
    if eslint:
        code, out = _run_check([eslint, "--no-color", str(path)], workspace)
        return "eslint", "" if code == 0 else out
    if path.suffix in (".ts", ".tsx"):
        return "", ""
    node = shutil.which("node")
    if not node or path.suffix == ".jsx":
        return "", ""
    code, out = _run_check([node, "--check", str(path)], workspace)
    return "node --check", "" if code == 0 else out


def _check_json(_workspace: Path, path: Path) -> tuple[str, str]:
    try:
        json.loads(path.read_text(encoding="utf-8"))
        return "json", ""
    except (OSError, ValueError) as exc:
        return "json", str(exc)


_CHECKERS = {
    ".py": _check_python,
    ".js": _check_js, ".jsx": _check_js, ".mjs": _check_js, ".cjs": _check_js,
    ".ts": _check_js, ".tsx": _check_js,
    ".json": _check_json,
}


def verify_file(workspace: Path, path: Path) -> tuple[str, str]:
    """(herramienta, errores). Errores vacío = pasó (o no hay verificador)."""
    checker = _CHECKERS.get(path.suffix.lower())
    if checker is None or not path.is_file():
        return "", ""
    tool, errors = checker(workspace, path)
    if len(errors) > MAX_CHECK_CHARS:
        errors = errors[:MAX_CHECK_CHARS] + "\n…[recortado]"
    return tool, errors
