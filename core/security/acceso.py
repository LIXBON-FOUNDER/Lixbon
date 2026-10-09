from __future__ import annotations

import ipaddress

# El orden importa: Edge y Opera se anuncian también como Chrome, y Chrome
# como Safari.
_NAVEGADORES = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                ("Chrome/", "Chrome"), ("Safari/", "Safari"))
_SISTEMAS = (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iOS"),
             ("iPad", "iPadOS"), ("Mac OS X", "macOS"), ("Linux", "Linux"))

# Por el nombre de la key (las apps lo mandan al entrar) o, si no, por el
# user-agent: la app Android sale como okhttp/<versión>.
_APPS = {"lixbon mobile": "app móvil", "lixbon desktop": "IDE", "lixbon ide": "IDE",
         "lixbon cli": "CLI"}
_APPS_POR_AGENTE = (("lixbon-cli", "CLI"), ("okhttp", "app móvil"), ("lixbon", "IDE"))


def _buscar(ua: str, tabla) -> str:
    return next((nombre for marca, nombre in tabla if marca in ua), "")


def navegador_y_sistema(user_agent: str | None) -> tuple[str, str]:
    ua = user_agent or ""
    return _buscar(ua, _NAVEGADORES), _buscar(ua, _SISTEMAS)


def app_de(user_agent: str | None, key_name: str | None = None) -> str | None:
    if key_name and key_name.strip().lower() in _APPS:
        return _APPS[key_name.strip().lower()]
    return _buscar((user_agent or "").lower(), _APPS_POR_AGENTE) or None


def clase_de_dispositivo(user_agent: str | None, key_name: str | None = None) -> str:
    # Sin versiones: cada actualización del navegador o de la app cambia el
    # user-agent y con la huella del agente completo cualquier regreso parecía
    # un dispositivo nuevo.
    app = app_de(user_agent, key_name)
    if app:
        return f"app:{app}"
    navegador, sistema = navegador_y_sistema(user_agent)
    return f"web:{navegador or '?'}/{sistema or '?'}"


def red_de(ip: str | None) -> str | None:
    # La red del proveedor y no la IP exacta: la IP doméstica o la móvil cambia
    # a menudo dentro del mismo rango, y eso no es una ubicación distinta.
    try:
        dir_ip = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return None
    if dir_ip.is_loopback or dir_ip.is_private:
        return "local"
    prefijo = 16 if dir_ip.version == 4 else 32
    return str(ipaddress.ip_network(f"{dir_ip}/{prefijo}", strict=False))
