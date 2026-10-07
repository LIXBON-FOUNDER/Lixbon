"""
renderer.py — HTML de una pieza → PNG o MP4 con Chromium (Playwright) y ffmpeg.

El HTML es contenido no confiable que corre en el servidor. Toda petición de red
pasa por `_allow`: solo salen http(s) a IPs públicas (nada de la red privada de
Railway, metadatos de la nube ni localhost), archivos del directorio de assets
de marca y data:/blob:. Tamaño y duración están acotados.
"""
from __future__ import annotations

import ipaddress
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

MAX_SIDE = 2160 * 2
MAX_SECONDS = 60.0
FPS = 30
NAV_TIMEOUT_MS = 20_000
REPO = Path(__file__).resolve().parents[2]
ASSETS_DIR = Path(os.getenv("RENDER_ASSETS_DIR") or REPO / "apps" / "web" / "public").resolve()


class RenderError(Exception):
    pass


BRAND_FONTS = (("Bruno Ace SC", "bruno-ace-sc-latin.woff2", "400"),
               ("Geist", "geist-latin.woff2", "100 900"),
               ("Geist Mono", "geist-mono-latin.woff2", "100 900"))


def brand_fonts_css(fonts_url: str) -> str:
    """@font-face de las fuentes de marca. Se inyecta siempre: una pieza que nombra
    'Geist' sin declararla caería en una fuente del sistema."""
    return "".join(f"@font-face{{font-family:'{name}';src:url('{fonts_url}{file}');font-weight:{weight}}}"
                   for name, file, weight in BRAND_FONTS)


def inject_head(html: str, snippet: str) -> str:
    import re
    m = re.search(r"<head[^>]*>", html, re.I)
    return html[:m.end()] + snippet + html[m.end():] if m else snippet + html


def prepare_html(html: str) -> str:
    """Las piezas apuntan a fuentes e ícono con prefijos del skill o del repo."""
    base = ASSETS_DIR.as_uri() + "/"
    html = inject_head(html, f"<style data-lixbon-fonts>{brand_fonts_css(base + 'fonts/')}</style>")
    for old, new in (
        ("__ASSETS__/brand/fonts/", base + "fonts/"),
        ("__ASSETS__/brand/", base),
        ("__REPO__/apps/web/public/", base),
        ("__REPO__/assets/brand/", base),
    ):
        html = html.replace(old, new)
    return html


def _public_host(host: str, cache: dict[str, bool]) -> bool:
    if host in cache:
        return cache[host]
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, None)}
        ok = bool(addrs) and all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs)
    except (socket.gaierror, ValueError, UnicodeError):
        ok = False
    cache[host] = ok
    return ok


def allow_url(url: str, root: Path, cache: dict[str, bool]) -> bool:
    """`root` es la carpeta temporal con la pieza y los archivos de su visual."""
    parsed = urlparse(url)
    if parsed.scheme in ("data", "blob", "about"):
        return True
    if parsed.scheme == "file":
        from urllib.request import url2pathname
        target = Path(url2pathname(parsed.path)).resolve()
        return root.resolve() in target.parents or ASSETS_DIR in target.parents
    if parsed.scheme in ("http", "https") and parsed.hostname:
        return _public_host(parsed.hostname, cache)
    return False


def _ffmpeg() -> str:
    exe = os.getenv("FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:
        raise RenderError("No hay ffmpeg disponible para renderizar vídeo") from exc


def _launch(p):
    channel = os.getenv("RENDER_BROWSER_CHANNEL")
    if channel:
        return p.chromium.launch(channel=channel)
    try:
        return p.chromium.launch()
    except Exception:
        # En Windows sin `playwright install`, Edge viene con el sistema.
        return p.chromium.launch(channel="msedge")


def _scale(kind: str, width: int, height: int) -> int:
    # Las imágenes salen al doble de densidad (nítidas en pantallas retina y al
    # ampliarlas); el vídeo y las piezas enormes, a 1x para no disparar el peso.
    return 2 if kind == "image" and max(width, height) <= MAX_SIDE // 2 else 1


def render(html: str, kind: str, width: int, height: int, seconds: float = 0, *,
           path: str = "pieza.html", assets: dict[str, bytes] | None = None) -> bytes:
    if not (16 <= width <= MAX_SIDE and 16 <= height <= MAX_SIDE):
        raise RenderError(f"Tamaño fuera de rango: {width}x{height}")
    if kind == "video" and not (0 < seconds <= MAX_SECONDS):
        raise RenderError(f"Duración fuera de rango: {seconds}s (máx. {MAX_SECONDS:.0f})")
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory(prefix="lixbon_render_") as tmp:
        site = Path(tmp) / "site"
        for rel, data in (assets or {}).items():
            dest = (site / rel).resolve()
            if site.resolve() in dest.parents:  # rutas ya validadas al guardar; doble barrera
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
        html_file = (site / path).resolve()
        if site.resolve() not in html_file.parents:
            raise RenderError(f"Ruta de pieza no válida: {path}")
        html_file.parent.mkdir(parents=True, exist_ok=True)
        html_file.write_text(prepare_html(html), encoding="utf-8")
        cache: dict[str, bool] = {}
        with sync_playwright() as p:
            browser = _launch(p)
            try:
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=_scale(kind, width, height))
                page.route("**/*", lambda route: route.continue_() if allow_url(route.request.url, site, cache)
                           else route.abort("blockedbyclient"))
                page.goto(html_file.as_uri(), timeout=NAV_TIMEOUT_MS, wait_until="load")
                page.evaluate("document.fonts.ready")
                if kind == "image":
                    page.wait_for_timeout(300)
                    return page.screenshot(type="png")
                return _video(page, Path(tmp) / "out.mp4", seconds)
            finally:
                browser.close()


def _video(page, out: Path, seconds: float) -> bytes:
    # Cada fotograma se busca con la Web Animations API: salida determinista,
    # independiente de lo rápido que vaya la máquina. Solo anima CSS.
    # stderr va a un archivo: con una tubería que nadie lee durante el bucle,
    # ffmpeg la llena con su progreso, se bloquea y el render se cuelga.
    log = out.with_suffix(".log")
    with open(log, "wb") as err:
        proc = subprocess.Popen(
            [_ffmpeg(), "-y", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(out)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)
        page.evaluate("document.getAnimations().forEach(a => a.pause())")
        try:
            for i in range(int(seconds * FPS)):
                page.evaluate("t => document.getAnimations().forEach(a => { a.currentTime = t })", i * 1000 / FPS)
                proc.stdin.write(page.screenshot(type="png"))
        finally:
            proc.stdin.close()
        code = proc.wait()
    if code != 0:
        raise RenderError("ffmpeg falló: " + log.read_text("utf-8", "replace")[-300:])
    return out.read_bytes()
