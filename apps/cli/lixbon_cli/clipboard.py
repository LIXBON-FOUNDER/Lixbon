"""Pegar imágenes del portapapeles sin dependencias externas.

El CLI se distribuye como UN archivo que se autoinstala solo prompt_toolkit y
rich, así que aquí no se puede usar Pillow: el DIB de Windows se decodifica a
mano y el PNG se escribe con `zlib`, que es stdlib. Son ~80 líneas y evitan
arrastrar una dependencia binaria de 3 MB al instalador.
"""
import os
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

# Cuántos pegados se conservan en disco. Son capturas de pantalla: pesan y no
# vuelven a hacer falta una vez el modelo las ha visto.
PASTE_KEEP = 20

CF_DIB = 8
CF_HDROP = 15


def paste_dir(home: Path) -> Path:
    target = home / "pastes"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _prune(folder: Path) -> None:
    try:
        files = sorted(folder.glob("paste-*.png"), key=lambda p: p.stat().st_mtime)
    except OSError:
        return
    for old in files[:-PASTE_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def _new_path(folder: Path) -> Path:
    return folder / f"paste-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid() % 1000:03d}.png"


# ── PNG a mano ──────────────────────────────────────────────────────────────

def _chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def encode_png(width: int, height: int, rgb_rows: list[bytes]) -> bytes:
    """PNG RGB de 8 bits a partir de filas ya en orden superior→inferior."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rgb_rows)  # filtro 0 por fila
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", header)
            + _chunk(b"IDAT", zlib.compress(raw, 6))
            + _chunk(b"IEND", b""))


def dib_to_png(dib: bytes) -> bytes | None:
    """Convierte el CF_DIB del portapapeles de Windows a PNG.

    Solo 24 y 32 bits sin comprimir, que es lo que dejan las capturas de
    pantalla y los editores de imagen. El canal alfa SE DESCARTA a propósito:
    muchas apps copian 32 bits con alfa a cero y un PNG RGBA salido de ahí se
    vería completamente transparente (el modelo no vería nada).
    """
    if len(dib) < 40:
        return None
    header_size, width, height, _planes, bits, compression = struct.unpack_from("<IiiHHI", dib, 0)
    if header_size < 40 or bits not in (24, 32) or compression not in (0, 3):
        return None
    clr_used = struct.unpack_from("<I", dib, 32)[0]
    offset = header_size + clr_used * 4
    if compression == 3 and header_size == 40:
        offset += 12  # máscaras BI_BITFIELDS, que aquí no hacen falta
    bottom_up = height > 0
    height = abs(height)
    if width <= 0 or height <= 0:
        return None

    stride = ((width * bits + 31) // 32) * 4
    if len(dib) < offset + stride * height:
        return None

    step = bits // 8
    rows: list[bytes] = []
    for y in range(height):
        start = offset + y * stride
        line = dib[start:start + width * step]
        # El DIB guarda BGR(A); PNG quiere RGB.
        rows.append(bytes(b for x in range(0, len(line), step)
                          for b in (line[x + 2], line[x + 1], line[x])))
    if bottom_up:
        rows.reverse()
    return encode_png(width, height, rows)


# ── Portapapeles por plataforma ─────────────────────────────────────────────

def _windows_clipboard_image(folder: Path) -> tuple[Path | None, str]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    shell32 = ctypes.windll.shell32
    # SIN restype explícito, ctypes asume `int` (32 bits) y en un Windows de 64
    # bits TRUNCA los handles y punteros: GlobalSize devolvía 0 y la imagen
    # llegaba vacía. Es el fallo clásico de hablar con la Win32 API por ctypes.
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalSize.argtypes = [wintypes.HANDLE]
    shell32.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT,
                                       wintypes.LPWSTR, wintypes.UINT]

    def _read(handle) -> bytes:
        size = kernel32.GlobalSize(handle)
        pointer = kernel32.GlobalLock(handle)
        if not pointer or not size:
            return b""
        try:
            return ctypes.string_at(pointer, size)
        finally:
            kernel32.GlobalUnlock(handle)

    # Muchas apps (navegadores, capturas, editores) publican también un PNG ya
    # hecho: usarlo evita decodificar el DIB y conserva la calidad original.
    png_format = user32.RegisterClipboardFormatW("PNG")

    if not user32.OpenClipboard(None):
        return None, "no se pudo abrir el portapapeles"
    try:
        # Un archivo copiado en el Explorador vale igual que un mapa de bits, y
        # además conserva el formato original (mejor que reencodificar).
        if user32.IsClipboardFormatAvailable(CF_HDROP):
            handle = user32.GetClipboardData(CF_HDROP)
            if handle:
                count = shell32.DragQueryFileW(handle, 0xFFFFFFFF, None, 0)
                for index in range(count):
                    length = shell32.DragQueryFileW(handle, index, None, 0)
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    shell32.DragQueryFileW(handle, index, buffer, length + 1)
                    candidate = Path(buffer.value)
                    if candidate.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                        return candidate, ""

        data = b""
        if png_format and user32.IsClipboardFormatAvailable(png_format):
            data = _read(user32.GetClipboardData(png_format))
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                target = _new_path(folder)
                target.write_bytes(data)
                _prune(folder)
                return target, ""

        if not user32.IsClipboardFormatAvailable(CF_DIB):
            return None, "el portapapeles no tiene ninguna imagen"
        dib = _read(user32.GetClipboardData(CF_DIB))
    finally:
        user32.CloseClipboard()

    if not dib:
        return None, "no se pudo leer la imagen del portapapeles"
    png = dib_to_png(dib)
    if png is None:
        return None, "formato de imagen no soportado (usa 24 o 32 bits sin comprimir)"
    target = _new_path(folder)
    target.write_bytes(png)
    _prune(folder)
    return target, ""


def _command_clipboard_image(folder: Path) -> tuple[Path | None, str]:
    """Linux/macOS: se delega en la herramienta del sistema, si está."""
    attempts = [
        (["wl-paste", "--no-newline", "--type", "image/png"], ".png"),
        (["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], ".png"),
        (["pngpaste", "-"], ".png"),
    ]
    missing = True
    for command, _suffix in attempts:
        try:
            proc = subprocess.run(command, capture_output=True, timeout=10)
        except (FileNotFoundError, OSError):
            continue
        except subprocess.TimeoutExpired:
            missing = False
            continue
        missing = False
        if proc.returncode == 0 and proc.stdout[:8] == b"\x89PNG\r\n\x1a\n":
            target = _new_path(folder)
            target.write_bytes(proc.stdout)
            _prune(folder)
            return target, ""
    if missing:
        return None, "instala wl-clipboard, xclip o pngpaste para pegar imágenes"
    return None, "el portapapeles no tiene ninguna imagen"


def paste_image(home: Path) -> tuple[Path | None, str]:
    """Guarda la imagen del portapapeles y devuelve (ruta, error).

    Nunca lanza: pegar es un atajo, y que falle no puede tumbar el prompt.
    """
    try:
        folder = paste_dir(home)
        if sys.platform == "win32":
            return _windows_clipboard_image(folder)
        return _command_clipboard_image(folder)
    except Exception as exc:
        return None, f"no se pudo pegar la imagen ({exc})"
