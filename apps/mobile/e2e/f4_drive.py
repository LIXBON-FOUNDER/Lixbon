"""Native Android F4 acceptance using the local fixture gateway.

Requires an installed release APK with EXPO_PUBLIC_API_BASE=http://127.0.0.1:8765,
adb reverse tcp:8765 tcp:8765, and f4_gateway.py. Set ANDROID_SERIAL to isolate
the emulator. Starts from app data cleared by the caller; never uses real data.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys
import time
import urllib.request

import drive as ui

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "e2e-f4-out")
OUT.mkdir(parents=True, exist_ok=True)
ui.OUT = str(OUT)
checks = []


def api(path, post=False):
    request = urllib.request.Request(f"{ui.MOCK}{path}", data=b"{}" if post else None)
    return json.load(urllib.request.urlopen(request, timeout=10))


def scan(pattern, down=True, limit=18):
    rx = re.compile(pattern, re.I)
    for _ in range(limit):
        found = [n for n in ui.nodes() if any(rx.search(n.get(k, "")) for k in ("text", "content-desc", "hint"))]
        if found:
            return found[-1]
        ui.adb("shell", "input", "swipe", "360", "1040" if down else "300", "360", "300" if down else "1040", "350")
        time.sleep(0.4)
    raise AssertionError(f"Not visible after scrolling: {pattern}")


def top():
    for _ in range(16):
        ui.adb("shell", "input", "swipe", "360", "300", "360", "1100", "100")
    time.sleep(0.5)


def check(name):
    checks.append(name)
    ui.shot(f"{len(checks):02d}-{name}")
    (OUT / "results.json").write_text(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    ui.adb("shell", "pm", "grant", ui.PKG, "android.permission.POST_NOTIFICATIONS")
    ui.adb("shell", "am", "start", "-n", f"{ui.PKG}/.MainActivity")
    time.sleep(10)
    fields = ui.edits()
    assert len(fields) >= 2, "Expected clean fixture login"
    ui.tap(fields[0]); ui.type_text("ana@lixbon.com")
    ui.tap(ui.edits()[1]); ui.type_text("secreto123")
    ui.hide_keyboard()
    ui.tap(ui.find(r"^Iniciar Sesi[oó]n\s*$", last=True))
    ui.find(r"Escribe un mensaje", timeout=35)
    print("login ok", flush=True)
    ui.tap(ui.find(r"Abrir men[uú]"))
    ui.tap(ui.find(r"Ana.*ajustes"))
    ui.tap(scan(r"^Prototipo de supervisi[oó]n$"))
    ui.adb("shell", "input", "keyevent", "4")
    ui.tap(ui.find(r"Abrir men[uú]"))
    ui.tap(ui.find(r"^Supervisar$"))
    ui.tap(ui.find(r"^Trabajo activo:"))
    print("Supervisar abierto", flush=True)
    ui.tap(scan(r"Validar Mobile F4.*abre la tarea"))
    ui.tap(scan(r"Intento.*actual.*claude"))
    scan(r"Responder al proveedor\. Disponible")
    check("capabilities-available")

    api("/__e2e/scenario/blocked", True)
    ui.tap(scan(r"^Actualizar capacidades$"))
    scan(r"Responder al proveedor\. Bloqueado por el entorno", down=False)
    scan(r"Orientar durante la ejecuci[oó]n\. No soportado", down=False)
    check("capabilities-blocked")
    api("/__e2e/scenario/ready", True)
    ui.tap(scan(r"^Actualizar capacidades$"))
    scan(r"^Paquete v[aá]lido$")
    scan(r"Origen.*t-205 / a-1")
    check("context-valid-provenance")
    api("/__e2e/scenario/partial", True)
    ui.tap(scan(r"^Actualizar contexto$"))
    scan(r"Se ocultaron valores al crear el paquete", down=False)
    scan(r"El paquete contiene campos recortados")
    check("context-redacted-truncated")
    ui.tap(scan(r"^Actualizar contexto$"))
    api("/__e2e/scenario/corrupt", True)
    ui.tap(ui.find(r"^Actualizar contexto$"))
    scan(r"^Paquete inv[aá]lido$", down=False)
    check("context-corrupt")
    api("/__e2e/scenario/absent", True)
    ui.tap(scan(r"^Actualizar contexto$"))
    scan(r"^Sin paquete guardado$", down=False)
    check("context-absent")
    api("/__e2e/scenario/ready", True)
    ui.tap(scan(r"^Actualizar contexto$"))
    scan(r"^Paquete v[aá]lido$", down=False)

    top()
    ui.tap(ui.find(r"^Volver$"))
    ui.tap(ui.find(r"^Volver$"))
    ui.tap(scan(r"Consultar uso de proveedores"))
    ui.find(r"^codex$")
    ui.find(r"Al d[ií]a")
    scan(r"Sin datos de uso")
    scan(r"No informa de su uso")
    check("usage-cross-provider-unknown-unsupported")
    api("/__e2e/scenario/rate_limited", True)
    ui.tap(scan(r"^Actualizar uso$"))
    top()
    scan(r"El proveedor limita las consultas")
    check("usage-rate-limit")

    top()
    api("/__e2e/host/false", True)
    ui.find(r"Sin conexi[oó]n|IDE desconectado", timeout=20)
    scan(r"Datos de la [uú]ltima sincronizaci[oó]n")
    check("offline-stale")
    api("/__e2e/host/true", True)
    api("/__e2e/scenario/ready", True)
    time.sleep(5)
    top()
    ui.find(r"Al d[ií]a", timeout=20)
    check("reconnected")

    ui.adb("shell", "input", "keyevent", "3")
    time.sleep(4)
    before = len([r for r in api("/__e2e/state")["requests"] if r["action"] in {"core_usage", "core_attempt_context", "core_attempt_capabilities"}])
    time.sleep(34)
    after = len([r for r in api("/__e2e/state")["requests"] if r["action"] in {"core_usage", "core_attempt_context", "core_attempt_capabilities"}])
    assert before == after, f"Background polling continued: {before} -> {after}"
    ui.adb("shell", "am", "start", "-n", f"{ui.PKG}/.MainActivity")
    ui.find(r"Al d[ií]a", timeout=20)
    check("background-paused-foreground-resumed")
    state = api("/__e2e/state")
    assert not state["failures"], state["failures"]
    assert {"core_attempt_capabilities", "core_attempt_context", "core_usage"} <= {r["action"] for r in state["requests"]}
    (OUT / "relay-evidence.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        (OUT / "results.json").write_text(json.dumps({"ok": False, "checks": checks, "error": str(error)}, ensure_ascii=False, indent=2), encoding="utf-8")
        ui.shot("failure")
        raise
