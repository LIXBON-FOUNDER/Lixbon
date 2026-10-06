"""Mediciones locales del Python actual; no accede al gateway ni al config del usuario."""
import argparse
import gc
import importlib.util
import json
import platform
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI_DIR))

from lixbon_cli.agent import clean_prose, tool_read_file


def measure(operation, allocations=False):
    runs = []
    for _ in range(3):
        gc.collect()
        if allocations:
            tracemalloc.start()
        wall = time.perf_counter()
        cpu = time.process_time()
        result = operation()
        item = {
            "wall_ms": (time.perf_counter() - wall) * 1000,
            "cpu_ms": (time.process_time() - cpu) * 1000,
            "result_chars": len(result),
        }
        if allocations:
            item["peak_python_bytes"] = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
        runs.append(item)
    return {
        key: round(statistics.median(run[key] for run in runs), 3)
        for key in runs[0]
    }


def stream_work(events):
    parts = []
    for _ in range(events):
        parts.append("Una respuesta de texto del agente, sin llamadas a herramientas.\n")
        visible = clean_prose("".join(parts))
    return visible


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=CLI_DIR, text=True
    ).strip()
    spec = importlib.util.spec_from_file_location("lixbon_audit_build", CLI_DIR / "build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    generated = build.generate()
    current = (CLI_DIR / "client_cli.py").read_text(encoding="utf-8")
    report = {
        "commit": revision,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "repetitions": 3,
        "artifact_fresh": generated == current,
        "limitations": [
            "Mediana local; no comparacion con Go ni medicion de RSS.",
            "El replay incluye join y clean_prose; excluye Rich, terminal y red.",
            "La lectura usa tracemalloc y cache del sistema; no representa disco frio.",
        ],
        "stream_prefix_reprocessing": [
            {"events": count, **measure(lambda n=count: stream_work(n))}
            for count in (1000, 2000, 4000)
        ],
    }
    scratch = Path(tempfile.mkdtemp(prefix="lixbon-cli-audit-")).resolve()
    fixture = scratch / "large.txt"
    try:
        fixture.write_bytes((b"x" * 1023 + b"\n") * 16384)
        report["read_first_20_lines"] = {
            "file_bytes": fixture.stat().st_size,
            **measure(lambda: tool_read_file(scratch, "large.txt", 1, 20), allocations=True),
        }
    finally:
        fixture.unlink(missing_ok=True)
        scratch.rmdir()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + "\n", encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
