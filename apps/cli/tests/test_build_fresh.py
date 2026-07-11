"""Verifica que client_cli.py esté al día con los módulos de lixbon_cli/.

Si falla: alguien editó los módulos sin regenerar el artefacto (o editó el
artefacto a mano). Corre `python apps/cli/build.py`.
"""
import hashlib
import importlib.util
import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parents[1]


def _load_build_module():
    spec = importlib.util.spec_from_file_location("lixbon_build", CLI_DIR / "build.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["lixbon_build"] = module
    spec.loader.exec_module(module)
    return module


def test_client_cli_is_fresh():
    build = _load_build_module()
    generated = build.generate()
    on_disk = (CLI_DIR / "client_cli.py").read_text(encoding="utf-8")
    gen_hash = hashlib.sha256(generated.encode("utf-8")).hexdigest()
    disk_hash = hashlib.sha256(on_disk.replace("\r\n", "\n").encode("utf-8")).hexdigest()
    assert gen_hash == disk_hash, (
        "client_cli.py está desactualizado respecto a lixbon_cli/. "
        "Regenera con: python apps/cli/build.py"
    )
