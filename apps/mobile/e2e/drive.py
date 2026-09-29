"""Recorre la app en el emulador con adb y deja capturas en OUT.

Comprueba lo que no se puede ver sin un Android de verdad: que con el teclado
abierto la caja de texto queda por encima de él (chat, remoto y login).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

OUT = sys.argv[1] if len(sys.argv) > 1 else "e2e-out"
PKG = "com.usuario.lixbon"
MOCK = "http://127.0.0.1:8765"
results: dict[str, object] = {}


def adb(*args: str) -> str:
    return subprocess.run(["adb", *args], capture_output=True, text=True, errors="replace").stdout


def shot(name: str) -> None:
    time.sleep(1.2)
    with open(f"{OUT}/{name}.png", "wb") as fh:
        fh.write(subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True).stdout)
    print(f"captura {name}", flush=True)


def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    raw = adb("exec-out", "cat", "/sdcard/ui.xml")
    try:
        root = ET.fromstring(raw[raw.index("<"):])
    except (ValueError, ET.ParseError):
        return []
    out = []
    for n in root.iter("node"):
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
        if m:
            out.append({**n.attrib, "box": tuple(int(v) for v in m.groups())})
    return out


def label(n) -> str:
    return f"{n.get('text', '')} {n.get('content-desc', '')} {n.get('hint', '')}"


def find(pattern: str, timeout: float = 25, last: bool = False, cls: str | None = None):
    rx = re.compile(pattern, re.I)
    end = time.time() + timeout
    while time.time() < end:
        found = [
            n for n in nodes()
            if any(rx.search(n.get(k, "")) for k in ("text", "content-desc", "hint"))
            and (cls is None or n.get("class") == cls)
        ]
        if found:
            return found[-1] if last else found[0]
        dismiss_system_dialogs()
        time.sleep(1)
    raise SystemExit(f"no aparece: {pattern}")


def dismiss_system_dialogs() -> None:
    """El emulador de CI a veces saca un "X isn't responding" del sistema."""
    dialogs = [n for n in nodes() if n.get("text") in ("Wait", "Esperar") and n.get("package") == "android"]
    for n in dialogs:
        x1, y1, x2, y2 = n["box"]
        adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
        time.sleep(0.8)
    adb("shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS")
    return bool(dialogs)


def edits():
    for _ in range(10):
        found = [n for n in nodes() if n.get("class") == "android.widget.EditText"]
        if found:
            return found
        dismiss_system_dialogs()
        time.sleep(2)
    return []


def tap(n, dismiss: bool = True) -> None:
    # CLOSE_SYSTEM_DIALOGS también pliega la cortina de notificaciones.
    if dismiss:
        dismiss_system_dialogs()
    x1, y1, x2, y2 = n["box"]
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(0.8)


def type_text(text: str) -> None:
    adb("shell", "input", "text", text.replace(" ", "%s"))
    time.sleep(0.6)


def ime_top() -> int | None:
    """Borde superior del teclado en píxeles, leído de los insets del sistema."""
    dump = adb("shell", "dumpsys", "window", "InputMethod")
    tops = [int(m.group(2)) for m in re.finditer(r"(?:mFrame|frame)=\[(\d+),(\d+)\]\[(\d+),(\d+)\]", dump)
            if int(m.group(2)) > 200]
    if tops:
        return min(tops)
    dump = adb("shell", "dumpsys", "window")
    m = re.search(r"type=ime,? frame=\[\d+,(\d+)\]\[\d+,\d+\][^\n]*? visible=true", dump)
    if m:
        return int(m.group(1))
    for line in dump.splitlines():
        if "ime" in line.lower() and "frame" in line.lower():
            print("  [ime?] " + line.strip()[:220], flush=True)
    return None


def check_above_keyboard(name: str) -> None:
    time.sleep(1.5)
    if dismiss_system_dialogs():
        tap(edits()[-1])
        time.sleep(1.5)
    shown = "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    boxes = edits()
    top = ime_top()
    bottom = max((n["box"][3] for n in boxes), default=None)
    ok = bool(shown and top and bottom and bottom <= top + 2)
    results[name] = {"teclado_visible": shown, "borde_teclado": top, "borde_caja": bottom, "ok": ok}
    print(f"{name}: {results[name]}", flush=True)
    shot(name)


def hide_keyboard() -> None:
    if "mInputShown=true" in adb("shell", "dumpsys", "input_method"):
        adb("shell", "input", "keyevent", "111")
        time.sleep(1)


def main() -> None:
    # El diálogo de notificaciones taparía la app a mitad del recorrido.
    adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS")
    adb("shell", "settings", "put", "global", "hide_error_dialogs", "1")
    time.sleep(15)
    dismiss_system_dialogs()
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(8)
    dismiss_system_dialogs()
    shot("01-login")

    # Login contra el gateway simulado
    fields = edits()
    tap(fields[0])
    type_text("ana@lixbon.com")
    tap(edits()[1])
    type_text("secreto123")
    check_above_keyboard("02-login-teclado")
    hide_keyboard()
    tap(find(r"^Iniciar Sesi[oó]n\s*$", last=True))
    find(r"Escribe un mensaje", timeout=30)
    shot("03-chat")

    # Chat: el teclado no puede tapar la caja
    composer = edits()[-1]
    tap(composer)
    check_above_keyboard("04-chat-teclado")
    type_text("Hola desde el emulador")
    shot("05-chat-escribiendo")
    hide_keyboard()

    # Paleta (Modal): mismo requisito
    tap(find(r"Buscar o ejecutar"))
    check_above_keyboard("06-paleta-teclado")
    # Un "atrás" de más cerraría la app: se pulsa solo mientras la paleta siga abierta.
    for _ in range(3):
        if any(re.fullmatch(r"\s*Remoto\s*", n.get("text", "")) for n in nodes()):
            break
        adb("shell", "input", "keyevent", "4")
        time.sleep(1)

    # Remoto: lista con las marcas de cada agente
    tap(find(r"^Remoto$"))
    find(r"Arreglar el login con Google")
    shot("07-remoto-lista")

    tap(find(r"Arreglar el login con Google"))
    find(r"Permitir", timeout=20)
    shot("08-remoto-claude")

    tap(edits()[-1])
    check_above_keyboard("09-remoto-teclado")

    type_text("/")
    time.sleep(1)
    shot("10-remoto-comandos")
    adb("shell", "input", "keyevent", "67")

    type_text("Revisa @aut")
    time.sleep(2.5)
    shot("11-remoto-mencion")
    tap(find(r"^auth\.py$"))
    type_text("y el callback")
    shot("12-remoto-mencion-elegida")
    hide_keyboard()
    tap(find(r"^Enviar$", last=True))
    time.sleep(2)
    shot("13-remoto-enviado")

    tap(find(r"^Permitir$"))
    time.sleep(1.5)
    shot("14-remoto-aprobado")

    # Hojas inferiores con el diseño de la app
    tap(find(r"^Adjuntar$"))
    find(r"Imagen de la galer")
    shot("14b-hoja-adjuntar")
    adb("shell", "input", "keyevent", "4")
    time.sleep(1)
    tap(find(r"Opciones de la sesi"))
    find(r"Terminar sesi")
    shot("14c-hoja-opciones")
    adb("shell", "input", "keyevent", "4")
    time.sleep(1)

    # Un «/» sin argumentos se envía al elegirlo y su resultado llega como tarjeta
    tap(edits()[-1])
    type_text("/sta")
    time.sleep(1)
    shot("14d-menu-comandos")
    tap(find(r"^/status$"))
    find(r"2\.1\.0 \(Claude Code\)", timeout=15)
    hide_keyboard()
    shot("14e-resultado-comando")
    results["comando_status"] = {"ok": True}

    # Sesión nueva en el IDE → aviso en el teléfono → al tocarlo se abre
    req = urllib.request.Request(f"{MOCK}/__e2e/new_session", data=b"{}", method="POST")
    print("new_session:", urllib.request.urlopen(req, timeout=10).read().decode(), flush=True)
    title = "Revisar las notificaciones push"
    shown = False
    for _ in range(15):
        if title in adb("shell", "dumpsys", "notification", "--noredact"):
            shown = True
            break
        time.sleep(1)
    results["notificacion_sesion_nueva"] = {"ok": shown}
    adb("shell", "cmd", "statusbar", "expand-notifications")
    time.sleep(1.5)
    shot("14f-notificacion")
    if shown:
        shade = [n for n in nodes() if n.get("text") == title]
        if shade:
            tap(shade[0], dismiss=False)
        time.sleep(3)
        header = [n for n in nodes() if n.get("text") == title]
        results["notificacion_abre_sesion"] = {"ok": bool(header)}
        shot("14g-sesion-desde-notificacion")
    else:
        adb("shell", "cmd", "statusbar", "collapse")

    tap(find(r"Volver a las sesiones"))
    tap(find(r"Refactor del reducer remoto"))
    find(r"remote\.js", timeout=20)
    shot("15-remoto-lixbon")
    tap(find(r"Volver a las sesiones"))
    tap(find(r"api-server"))
    time.sleep(3)
    shot("16-remoto-cli-terminada")

    with open(f"{OUT}/resultados.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
    failed = [k for k, v in results.items() if not v["ok"]]
    print("FALLAN: " + ", ".join(failed) if failed else "TODO OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        shot("zz-final")
