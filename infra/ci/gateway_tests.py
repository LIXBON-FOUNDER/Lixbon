import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Varios módulos fijan DATABASE_URL al importarse y fallan al compartir proceso.
def main() -> int:
    modules = sorted((ROOT / "core" / "gateway").glob("test_*.py"))
    failed = []
    for module in modules:
        name = module.relative_to(ROOT).as_posix()
        print(f"\n=== {name}", flush=True)
        result = subprocess.run([sys.executable, "-m", "pytest", name, "-q", "-p", "no:cacheprovider"], cwd=ROOT)
        if result.returncode != 0:
            failed.append(name)
    print(f"\n{len(modules) - len(failed)}/{len(modules)} módulos correctos")
    for name in failed:
        print(f"FALLA {name}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
