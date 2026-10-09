from __future__ import annotations

import html
import os

TEXTO = "'Source Serif 4', Georgia, 'Times New Roman', serif"
UI = "Geist, 'Helvetica Neue', Helvetica, Arial, sans-serif"
MONO = "'Geist Mono', 'SFMono-Regular', Menlo, Consolas, monospace"
NUMERO = "Lancelot, Georgia, serif"

CREMA = "#f2f1e3"
TARJETA = "#fcfaef"
BLANCO = "#ffffff"
BORDE = "#e4dfce"
BORDE_TENUE = "#ede9db"
TINTA = "#1b1a17"
TINTA_SUAVE = "#4a473f"
GRIS = "#5b584f"
APAGADO = "#6f6957"
OLIVO = "#4b5327"

_BASE = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
# Las imágenes salen de apps/web/public/email. Gmail no pinta SVG ni carga
# fuentes web, por eso el logo y las cabeceras van como PNG a 2x.
ACTIVOS = (os.getenv("EMAIL_ASSETS_URL") or f"{_BASE}/email").rstrip("/")

HERO_BIENVENIDA = ("hero-bienvenida.png", 290, "Bienvenido a lixbon")
HERO_ACCESO = ("hero-acceso.png", 240, "Nuevo acceso a tu cuenta")
HERO_TERMINOS = ("hero-terminos.png", 280, "lixbon founder · Términos y condiciones")


def _esc(v: object) -> str:
    return html.escape(str(v or ""), quote=True)


def boton(texto: str, url: str) -> str:
    return (
        f'<a href="{_esc(url)}" style="display:inline-block;background:{TINTA};color:{TARJETA};'
        f'font-family:{UI};font-size:15px;font-weight:500;line-height:1;padding:16px 28px;'
        f'border-radius:6px;text-decoration:none;">{_esc(texto)}</a>'
    )


def enlace(texto: str, url: str) -> str:
    return (
        f'<a href="{_esc(url)}" style="font-family:{UI};font-size:14px;font-weight:500;'
        f'color:{OLIVO};text-decoration:underline;">{_esc(texto)}</a>'
    )


def etiqueta(texto: str, color: str = OLIVO, margen: str = "0 0 8px") -> str:
    return (
        f'<p style="margin:{margen};font-family:{UI};font-size:11px;font-weight:500;'
        f'letter-spacing:0.14em;text-transform:uppercase;color:{color};">{_esc(texto)}</p>'
    )


def parrafo(texto_html: str, tamano: int = 16, color: str = TINTA_SUAVE, margen: str = "0 0 22px") -> str:
    return (
        f'<p style="margin:{margen};font-family:{TEXTO};font-size:{tamano}px;'
        f'line-height:1.65;color:{color};">{texto_html}</p>'
    )


def caja(contenido_html: str, relleno: str = "20px 22px", fondo: str = CREMA, borde: bool = False) -> str:
    linea = f"border:1px solid {BORDE};" if borde else ""
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background:{fondo};{linea}border-radius:6px;">'
        f'<tr><td style="padding:{relleno};">{contenido_html}</td></tr></table>'
    )


def filas_dato(pares: list[tuple[str, str]]) -> str:
    filas = []
    for i, (nombre, valor) in enumerate(pares):
        ultima = i == len(pares) - 1
        borde = "" if ultima else f"border-bottom:1px solid {BORDE_TENUE};"
        filas.append(
            f'<tr>'
            f'<td style="padding:14px 0;{borde}font-family:{UI};font-size:11px;font-weight:500;'
            f'letter-spacing:0.12em;text-transform:uppercase;color:{APAGADO};white-space:nowrap;'
            f'vertical-align:top;width:118px;">{_esc(nombre)}</td>'
            f'<td style="padding:12px 0;{borde}font-family:{TEXTO};font-size:15.5px;'
            f'color:{TINTA};vertical-align:top;">{valor}</td>'
            f'</tr>'
        )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        + "".join(filas) + "</table>"
    )


def datos(pares: list[tuple[str, str]]) -> str:
    return caja(filas_dato(pares), relleno="4px 20px", fondo=BLANCO, borde=True)


def lista_numerada(items: list[tuple[str, str, str]]) -> str:
    filas = "".join(
        f'<tr>'
        f'<td style="padding:18px 0;border-bottom:1px solid {BORDE};width:46px;vertical-align:top;'
        f'font-family:{NUMERO};font-size:24px;line-height:1.05;color:{OLIVO};">{_esc(marca)}</td>'
        f'<td style="padding:18px 0;border-bottom:1px solid {BORDE};vertical-align:top;">'
        f'<p style="margin:0 0 3px;font-family:{TEXTO};font-size:16px;font-weight:600;color:{TINTA};">{_esc(titulo)}</p>'
        f'<p style="margin:0;font-family:{TEXTO};font-size:15px;line-height:1.55;color:{GRIS};">{_esc(texto)}</p>'
        f'</td></tr>'
        for marca, titulo, texto in items
    )
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="border-top:1px solid {BORDE};">{filas}</table>'
    )


def url_cruda(url: str) -> str:
    return (
        f'<p style="margin:0 0 10px;font-family:{UI};font-size:13px;font-weight:500;color:{TINTA_SUAVE};">¿El botón no funciona?</p>'
        f'<div style="background:{CREMA};border-radius:6px;padding:12px 14px;font-family:{MONO};'
        f'font-size:12px;line-height:1.55;color:{GRIS};word-break:break-all;">{_esc(url)}</div>'
    )


def _pie_enlaces() -> str:
    estilo = f"color:{TINTA_SUAVE};text-decoration:underline;"
    return (
        f'<a href="{_BASE}/legal/terms" style="{estilo}">Términos</a>&nbsp;&nbsp;·&nbsp;&nbsp;'
        f'<a href="{_BASE}/legal/privacy" style="{estilo}">Privacidad</a>&nbsp;&nbsp;·&nbsp;&nbsp;'
        f'<a href="{_BASE}/support" style="{estilo}">Soporte</a>'
    )


def envoltura(*, eyebrow: str, titulo: str, cuerpo_html: str, pie_html: str = "",
              hero: tuple[str, int, str] | None = None, resumen: str = "") -> str:
    pie = pie_html or "Enviado por lixbon desde no-reply@lixbon.com. Este buzón no admite respuestas."
    cabecera = ""
    if hero:
        archivo, alto, alt = hero
        cabecera = (
            f'<tr><td style="padding:0;font-size:0;line-height:0;">'
            f'<img src="{ACTIVOS}/{archivo}" width="598" height="{alto}" alt="{_esc(alt)}" '
            f'style="display:block;width:100%;max-width:598px;height:auto;border:0;'
            f'border-radius:8px 8px 0 0;background:{TINTA};"></td></tr>'
        )
    oculto = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:{CREMA};">{_esc(resumen)}</div>'
        if resumen else ""
    )
    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>{_esc(titulo)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lancelot&amp;family=Source+Serif+4:opsz,wght@8..60,400..600&amp;family=Geist:wght@400..600&amp;family=Geist+Mono&amp;display=swap">
<style>
@media (max-width: 620px) {{
  .lx-cuerpo {{ padding: 30px 24px 32px !important; }}
  .lx-titulo {{ font-size: 28px !important; }}
}}
</style>
</head>
<body style="margin:0;padding:0;background:{CREMA};">
{oculto}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:{CREMA};">
<tr><td align="center" style="padding:32px 12px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;">

<tr><td style="padding:0 4px 20px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td align="left"><a href="{_BASE}" style="text-decoration:none;"><img src="{ACTIVOS}/logo.png" width="111" height="34" alt="lixbon" style="display:block;border:0;"></a></td>
    <td align="right" style="font-family:{UI};font-size:11px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:{APAGADO};">{_esc(eyebrow)}</td>
  </tr></table>
</td></tr>

<tr><td>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:{TARJETA};border:1px solid {BORDE};border-radius:8px;border-collapse:separate;">
{cabecera}
<tr><td class="lx-cuerpo" style="padding:40px 44px 44px;">
  <h1 class="lx-titulo" style="margin:0 0 14px;font-family:{TEXTO};font-size:32px;line-height:1.15;font-weight:500;letter-spacing:-0.015em;color:{TINTA};">{_esc(titulo)}</h1>
  {cuerpo_html}
</td></tr>
</table>
</td></tr>

<tr><td style="padding:24px 6px 0;font-family:{UI};font-size:12px;line-height:1.7;color:{APAGADO};">
  <p style="margin:0 0 8px;">{_pie_enlaces()}</p>
  <p style="margin:0;">{pie}<br>lixbon · Medellín, Colombia</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


def raya(margen: str = "30px 0 22px") -> str:
    return f'<div style="height:1px;background:{BORDE};margin:{margen};font-size:0;line-height:0;">&nbsp;</div>'


def nota(texto: str) -> str:
    return parrafo(_esc(texto), tamano=14, color=APAGADO, margen="0")


def _hueco(alto: int) -> str:
    return f'<div style="height:{alto}px;font-size:0;line-height:0;">&nbsp;</div>'


def verificacion(url: str) -> tuple[str, str, str]:
    cuerpo = (
        parrafo("Creaste una cuenta en lixbon con esta dirección. Confírmala y la "
                "misma cuenta te servirá en el chat, en el IDE de escritorio y en la CLI.",
                margen="0 0 26px")
        + boton("Verificar correo", url)
        + parrafo("El enlace caduca en 48 horas y solo puede usarse una vez.",
                  tamano=13, color=APAGADO, margen="16px 0 0")
        + raya("28px 0 22px")
        + url_cruda(url)
        + parrafo("Si no creaste ninguna cuenta, ignora este correo: sin confirmar, la "
                  "dirección no queda asociada a nada y el enlace se apaga solo.",
                  tamano=13, color=APAGADO, margen="22px 0 0")
    )
    texto = (
        "Confirma tu correo\n\n"
        "Creaste una cuenta en lixbon con esta dirección. Confírmala y la misma cuenta "
        "te servirá en el chat, en el IDE de escritorio y en la CLI.\n\n"
        f"{url}\n\n"
        "El enlace caduca en 48 horas y solo puede usarse una vez.\n\n"
        "Si no creaste ninguna cuenta, ignora este correo.\n"
    )
    return ("Verifica tu correo — lixbon",
            envoltura(eyebrow="Verificación", titulo="Confirma tu correo", cuerpo_html=cuerpo),
            texto)


def bienvenida(*, plan_nombre: str, plan_limites: str, url: str, url_planes: str) -> tuple[str, str, str]:
    productos = lista_numerada([
        ("01", "Chat en lixbon.com", "Habla con los modelos desde el navegador, sin instalar nada."),
        ("02", "Lixbon IDE", "El editor de escritorio, con la IA trabajando dentro de tu proyecto."),
        ("03", "Lixbon CLI", "La terminal, para guiones y tareas que se repiten."),
    ])
    bloque_plan = caja(
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
        f'<td align="left" style="vertical-align:middle;">'
        + etiqueta("Tu plan", margen="0 0 4px")
        + f'<p style="margin:0 0 3px;font-family:{TEXTO};font-size:17px;font-weight:600;color:{TINTA};">Plan {_esc(plan_nombre)}</p>'
        f'<p style="margin:0;font-family:{TEXTO};font-size:14px;line-height:1.5;color:{GRIS};">{_esc(plan_limites)}</p></td>'
        f'<td align="right" style="vertical-align:middle;padding-left:16px;white-space:nowrap;">{enlace("Ver planes", url_planes)}</td>'
        f'</tr></table>',
        relleno="18px 20px",
    )
    cuerpo = (
        parrafo("Tu correo quedó confirmado. La misma cuenta abre los tres sitios donde "
                "vive lixbon, sin configurar nada más.", tamano=17, margen="0 0 30px")
        + productos
        + _hueco(28)
        + bloque_plan
        + _hueco(32)
        + boton("Abrir lixbon  →", url)
    )
    texto = (
        "Ya estás dentro\n\n"
        "Tu correo quedó confirmado. La misma cuenta abre los tres sitios donde vive lixbon:\n\n"
        "- Chat en lixbon.com: habla con los modelos desde el navegador.\n"
        "- Lixbon IDE: el editor de escritorio, con la IA dentro de tu proyecto.\n"
        "- Lixbon CLI: la terminal, para guiones y tareas que se repiten.\n\n"
        f"Plan {plan_nombre}: {plan_limites}\n\n"
        f"{url}\n"
    )
    return ("Ya estás dentro — lixbon",
            envoltura(eyebrow="Cuenta creada", titulo="Ya estás dentro", cuerpo_html=cuerpo,
                      hero=HERO_BIENVENIDA,
                      resumen="Tu cuenta está lista: chat, IDE y CLI con el mismo acceso."),
            texto)


def acceso(*, cuando: str, dispositivo: str, ip: str, url_proteger: str,
           ubicacion: str | None = None) -> tuple[str, str, str]:
    pares = [("Cuándo", _esc(cuando)), ("Desde", _esc(dispositivo))]
    if ubicacion:
        pares.append(("Dónde", f'{_esc(ubicacion)} <span style="color:{APAGADO};">· aproximado</span>'))
    pares.append(("Dirección IP", f'<span style="font-family:{MONO};">{_esc(ip)}</span>'))

    if ubicacion:
        cierre = ("La ubicación sale de la dirección IP y suele señalar la ciudad del "
                  "proveedor de internet, no la tuya. Que no coincida no significa por sí "
                  "solo que alguien haya entrado.")
    else:
        cierre = ("La dirección IP va recortada a propósito. Si no la reconoces, cambia la "
                  "contraseña: es la única acción que cierra de verdad el acceso de otro.")

    cuerpo = (
        parrafo("Se inició sesión en tu cuenta de lixbon desde un dispositivo que no "
                "habíamos visto antes. Si fuiste tú, no tienes que hacer nada.",
                tamano=17, margen="0 0 28px")
        + datos(pares)
        + _hueco(30)
        + caja(
            parrafo(f'<strong style="font-weight:600;color:{TINTA};">¿No reconoces este acceso?</strong> '
                    "Cambia la contraseña ahora. Al hacerlo se cierran todas las demás sesiones "
                    "y se revocan las claves de API activas.", margen="0 0 18px")
            + boton("Proteger mi cuenta", url_proteger),
            relleno="22px 22px 24px",
        )
        + _hueco(26)
        + nota(cierre)
    )
    lineas = [f"Cuándo: {cuando}", f"Desde: {dispositivo}"]
    if ubicacion:
        lineas.append(f"Dónde: {ubicacion} (aproximado)")
    lineas.append(f"Dirección IP: {ip}")
    texto = (
        "Nuevo inicio de sesión\n\n"
        "Se inició sesión en tu cuenta de lixbon desde un dispositivo que no habíamos "
        "visto antes. Si fuiste tú, no tienes que hacer nada.\n\n"
        + "\n".join(lineas)
        + "\n\n¿No reconoces este acceso? Cambia la contraseña ahora:\n"
        + f"{url_proteger}\n"
    )
    return ("Nuevo inicio de sesión en tu cuenta — lixbon",
            envoltura(eyebrow="Seguridad", titulo="Nuevo inicio de sesión", cuerpo_html=cuerpo,
                      hero=HERO_ACCESO, resumen=f"{dispositivo} · {cuando}",
                      pie_html="Este aviso es de seguridad: se envía siempre y no se puede desactivar."),
            texto)


def terminos_actualizados(*, vigencia: str, cambios: list[tuple[str, str]], url_terminos: str,
                          url_anterior: str | None, url_cuenta: str) -> tuple[str, str, str]:
    lista = lista_numerada([(f"§{i}", seccion, resumen) for i, (seccion, resumen) in enumerate(cambios, 1)])
    acciones = boton("Leer los términos", url_terminos)
    if url_anterior:
        acciones = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td style="padding-right:22px;">{acciones}</td>'
            f'<td>{enlace("Ver la versión anterior", url_anterior)}</td></tr></table>'
        )
    firma = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td style="padding-right:16px;vertical-align:middle;">'
        f'<img src="{ACTIVOS}/firma-founder.png" width="48" height="48" alt="lf" style="display:block;border:0;border-radius:6px;"></td>'
        f'<td style="vertical-align:middle;">'
        f'<p style="margin:0 0 2px;font-family:{TEXTO};font-style:italic;font-size:19px;color:{TINTA};">Gabriel Durango</p>'
        f'<p style="margin:0;font-family:{TEXTO};font-size:14px;color:{APAGADO};">Fundador de lixbon · '
        f'<a href="mailto:privacidad@lixbon.com" style="color:{APAGADO};">privacidad@lixbon.com</a></p>'
        f'</td></tr></table>'
    )
    cuerpo = (
        parrafo("Hemos revisado los términos y condiciones de lixbon. La nueva versión entra "
                f'en vigor el <strong style="font-weight:600;color:{TINTA};">{_esc(vigencia)}</strong>. '
                "Aquí tienes lo que cambia, en pocas palabras.", tamano=17, margen="0 0 30px")
        + etiqueta("Qué cambia", margen="0 0 10px")
        + lista
        + _hueco(26)
        + parrafo("Si sigues usando lixbon a partir de esa fecha, aceptas la nueva versión. "
                  "Si no estás de acuerdo, puedes cerrar tu cuenta desde "
                  f'<a href="{_esc(url_cuenta)}" style="color:{OLIVO};">Ajustes</a> '
                  "antes de que entre en vigor.", margen="0 0 26px")
        + acciones
        + raya("36px 0 26px")
        + firma
    )
    texto = (
        "Actualizamos nuestros términos\n\n"
        f"La nueva versión de los términos y condiciones de lixbon entra en vigor el {vigencia}.\n\n"
        "Qué cambia:\n"
        + "".join(f"- {seccion}: {resumen}\n" for seccion, resumen in cambios)
        + "\nSi sigues usando lixbon a partir de esa fecha, aceptas la nueva versión. Si no "
          "estás de acuerdo, puedes cerrar tu cuenta desde Ajustes antes de que entre en vigor.\n\n"
        f"Leer los términos: {url_terminos}\n"
        + (f"Versión anterior: {url_anterior}\n" if url_anterior else "")
        + "\nGabriel Durango, fundador de lixbon\n"
    )
    return ("Actualizamos nuestros términos y condiciones — lixbon",
            envoltura(eyebrow="Legal", titulo="Actualizamos nuestros términos", cuerpo_html=cuerpo,
                      hero=HERO_TERMINOS, resumen=f"Entran en vigor el {vigencia}. Esto es lo que cambia.",
                      pie_html="Te escribimos porque tienes una cuenta en lixbon: los cambios en los "
                               "términos se avisan siempre."),
            texto)


def suscripcion(*, plan_nombre: str, precio: str, limites: list[str],
                renovacion: str | None, url: str) -> tuple[str, str, str]:
    celdas: list[str] = []
    for i, limite in enumerate(limites):
        if i % 2 == 0:
            celdas.append("<tr>")
        celdas.append(
            f'<td width="50%" style="padding:0 8px 11px 0;font-family:{TEXTO};font-size:13.5px;'
            f'line-height:1.45;color:{TINTA_SUAVE};vertical-align:top;">'
            f'<span style="color:{OLIVO};font-weight:700;">·</span>&nbsp;{_esc(limite)}</td>'
        )
        if i % 2 == 1:
            celdas.append("</tr>")
    if len(limites) % 2 == 1:
        celdas.append('<td width="50%"></td></tr>')

    bloque = caja(
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="border-bottom:1px solid {BORDE_TENUE};"><tr>'
        f'<td align="left" style="padding-bottom:14px;font-family:{TEXTO};font-size:17px;font-weight:600;color:{TINTA};">{_esc(plan_nombre)}</td>'
        f'<td align="right" style="padding-bottom:14px;font-family:{TEXTO};font-size:15px;font-weight:600;color:{TINTA};">'
        f'{_esc(precio)} <span style="font-size:12.5px;font-weight:400;color:{APAGADO};">/ mes</span></td>'
        f'</tr></table>'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin-top:15px;">{"".join(celdas)}</table>',
        relleno="18px 20px 9px",
    )
    if renovacion:
        linea_renovacion = parrafo(
            f'Se renueva el <strong style="font-weight:600;color:{TINTA};">{_esc(renovacion)}</strong>. '
            "Te avisaremos por aquí antes de cada cobro.", tamano=14, margen="0 0 24px")
    else:
        linea_renovacion = parrafo("Te avisaremos por aquí antes de cada cobro.",
                                   tamano=14, margen="0 0 24px")

    cuerpo = (
        parrafo("Gracias por suscribirte. Los límites nuevos ya están aplicados: no hace "
                "falta que vuelvas a entrar ni que reinstales nada.", margen="0 0 26px")
        + bloque
        + _hueco(24)
        + linea_renovacion
        + boton("Ver mi suscripción", url)
        + raya()
        + nota("Puedes cancelar cuando quieras desde tu cuenta. El plan sigue activo hasta "
               "el final del periodo que ya pagaste, y después vuelve al Gratuito sin cobros nuevos.")
    )
    texto = (
        f"Tu plan {plan_nombre} está activo\n\n"
        "Gracias por suscribirte. Los límites nuevos ya están aplicados.\n\n"
        f"{plan_nombre} — {precio} / mes\n"
        + "".join(f"- {limite}\n" for limite in limites)
        + (f"\nSe renueva el {renovacion}.\n" if renovacion else "")
        + f"\n{url}\n"
    )
    return (f"Tu plan {plan_nombre} está activo — lixbon",
            envoltura(eyebrow="Suscripción", titulo=f"Tu plan {plan_nombre} está activo",
                      cuerpo_html=cuerpo),
            texto)


def reset_password(url: str) -> tuple[str, str, str]:
    cuerpo = (
        parrafo("Recibimos una solicitud para cambiar la contraseña de tu cuenta. "
                "Si no fuiste tú, ignora este correo: la contraseña actual sigue valiendo.",
                margen="0 0 26px")
        + boton("Cambiar contraseña", url)
        + parrafo("El enlace caduca en 2 horas y solo puede usarse una vez.",
                  tamano=13, color=APAGADO, margen="16px 0 0")
        + raya("28px 0 22px")
        + url_cruda(url)
    )
    texto = (
        "Restablecer contraseña\n\n"
        "Recibimos una solicitud para cambiar la contraseña de tu cuenta. "
        "Si no fuiste tú, ignora este correo.\n\n"
        f"{url}\n\n"
        "El enlace caduca en 2 horas.\n"
    )
    return ("Restablece tu contraseña — lixbon",
            envoltura(eyebrow="Seguridad", titulo="Restablecer contraseña", cuerpo_html=cuerpo),
            texto)


def password_cambiada(*, cuando: str, dispositivo: str, ip: str,
                      url_recuperar: str) -> tuple[str, str, str]:
    pares = [
        ("Cuándo", _esc(cuando)),
        ("Desde", _esc(dispositivo)),
        ("Dirección IP", f'<span style="font-family:{MONO};">{_esc(ip)}</span>'),
    ]
    cuerpo = (
        parrafo("La contraseña de tu cuenta de lixbon acaba de cambiar. Si fuiste tú, "
                "ya está: entra con la contraseña nueva y no tienes que hacer nada más.",
                margen="0 0 24px")
        + datos(pares)
        + _hueco(24)
        + parrafo("Al cambiarla se cerraron todas las sesiones abiertas y se revocaron "
                  "las claves de API activas. Las aplicaciones que las usaran —el IDE, "
                  "la CLI, tus guiones— piden iniciar sesión otra vez.", margen="0 0 24px")
        + parrafo(f'<strong style="font-weight:600;color:{TINTA};">¿No la cambiaste tú?</strong> '
                  "Alguien con acceso a este correo pudo hacerlo. Recupera la cuenta ahora: "
                  "el enlace te deja poner una contraseña nueva y vuelve a cerrar todo.",
                  margen="0 0 18px")
        + boton("Recuperar mi cuenta", url_recuperar)
        + raya()
        + nota("Si tampoco puedes entrar en este buzón, escríbenos desde otra dirección "
               "antes de intentar nada más.")
    )
    texto = (
        "Tu contraseña cambió\n\n"
        "La contraseña de tu cuenta de lixbon acaba de cambiar. Si fuiste tú, no tienes "
        "que hacer nada.\n\n"
        f"Cuándo: {cuando}\n"
        f"Desde: {dispositivo}\n"
        f"Dirección IP: {ip}\n\n"
        "Al cambiarla se cerraron todas las sesiones abiertas y se revocaron las claves "
        "de API activas.\n\n"
        "¿No la cambiaste tú? Recupera la cuenta ahora:\n"
        f"{url_recuperar}\n"
    )
    return ("Tu contraseña cambió — lixbon",
            envoltura(eyebrow="Seguridad", titulo="Tu contraseña cambió", cuerpo_html=cuerpo,
                      pie_html="Este aviso es de seguridad: se envía siempre y no se puede desactivar."),
            texto)


def suscripcion_cancelada(*, plan_nombre: str, limites_gratis: list[str],
                          url_planes: str) -> tuple[str, str, str]:
    lista = "".join(
        f'<p style="margin:0 0 7px;font-family:{TEXTO};font-size:13.5px;line-height:1.45;'
        f'color:{TINTA_SUAVE};"><span style="color:{OLIVO};font-weight:700;">·</span>&nbsp;{_esc(l)}</p>'
        for l in limites_gratis
    )
    bloque = caja(
        f'<p style="margin:0 0 12px;font-family:{TEXTO};font-size:14px;font-weight:600;'
        f'color:{TINTA};">Plan Gratuito — lo que sigues teniendo</p>{lista}',
        relleno="16px 18px 10px",
    )
    cuerpo = (
        parrafo(f'Tu plan <strong style="font-weight:600;color:{TINTA};">{_esc(plan_nombre)}</strong> '
                "terminó y no habrá más cobros. Tu cuenta sigue abierta: pasa al plan "
                "Gratuito desde ahora mismo.", margen="0 0 26px")
        + bloque
        + _hueco(24)
        + parrafo("No se borra nada. Tus conversaciones, tus proyectos y tus claves de API "
                  "siguen donde estaban; solo cambian los límites.", margen="0 0 24px")
        + boton("Volver a suscribirme", url_planes)
        + raya()
        + nota("Si cancelaste por error, volver a suscribirte tarda lo que tardes en pagar: "
               "el plan y sus límites se reactivan al instante.")
    )
    texto = (
        f"Tu plan {plan_nombre} terminó\n\n"
        f"Tu plan {plan_nombre} terminó y no habrá más cobros. Tu cuenta sigue abierta y "
        "pasa al plan Gratuito desde ahora mismo.\n\n"
        "Plan Gratuito — lo que sigues teniendo:\n"
        + "".join(f"- {l}\n" for l in limites_gratis)
        + "\nNo se borra nada: tus conversaciones, tus proyectos y tus claves de API siguen "
          "donde estaban.\n\n"
        f"{url_planes}\n"
    )
    return (f"Tu plan {plan_nombre} terminó — lixbon",
            envoltura(eyebrow="Suscripción", titulo=f"Tu plan {plan_nombre} terminó",
                      cuerpo_html=cuerpo),
            texto)


def pago_fallido(*, plan_nombre: str, importe: str | None, reintento: str | None,
                 url_pago: str) -> tuple[str, str, str]:
    pares = [("Plan", _esc(plan_nombre))]
    if importe:
        pares.append(("Importe", _esc(importe)))
    if reintento:
        pares.append(("Reintento", _esc(reintento)))

    if reintento:
        aviso = (f'Lo intentaremos otra vez el <strong style="font-weight:600;color:{TINTA};">'
                 f'{_esc(reintento)}</strong>. Tu plan sigue activo hasta entonces.')
    else:
        aviso = ("Lo intentaremos otra vez en los próximos días. Tu plan sigue activo "
                 "mientras tanto.")

    cuerpo = (
        parrafo("No pudimos cobrar la última factura de tu suscripción. Suele ser una "
                "tarjeta caducada, sin fondos o rechazada por el banco.", margen="0 0 24px")
        + datos(pares)
        + _hueco(24)
        + parrafo(aviso, margen="0 0 24px")
        + boton("Actualizar el método de pago", url_pago)
        + raya()
        + nota("Si todos los intentos fallan, la suscripción se cancela y la cuenta vuelve "
               "al plan Gratuito. No se borra nada, solo cambian los límites.")
    )
    lineas = [f"Plan: {plan_nombre}"]
    if importe:
        lineas.append(f"Importe: {importe}")
    if reintento:
        lineas.append(f"Reintento: {reintento}")
    texto = (
        "No pudimos cobrar tu suscripción\n\n"
        "No pudimos cobrar la última factura de tu suscripción. Suele ser una tarjeta "
        "caducada, sin fondos o rechazada por el banco.\n\n"
        + "\n".join(lineas)
        + "\n\n" + ("Lo intentaremos otra vez el " + reintento + ". " if reintento
                    else "Lo intentaremos otra vez en los próximos días. ")
        + "Tu plan sigue activo hasta entonces.\n\n"
        "Actualiza el método de pago:\n"
        f"{url_pago}\n"
    )
    return ("No pudimos cobrar tu suscripción — lixbon",
            envoltura(eyebrow="Facturación", titulo="No pudimos cobrar tu suscripción",
                      cuerpo_html=cuerpo),
            texto)


def recarga_automatica_fallida(*, pack_nombre: str, url_facturacion: str) -> tuple[str, str, str]:
    cuerpo = (
        parrafo("No pudimos cobrar la recarga automática de tu saldo de créditos, así que "
                "la desactivamos para no seguir intentándolo contra una tarjeta que el "
                "banco rechaza.", margen="0 0 24px")
        + datos([("Recarga", _esc(pack_nombre))])
        + _hueco(24)
        + parrafo("Tu plan y tus conversaciones no se ven afectados. Lo que se queda sin "
                  "saldo son las peticiones hechas con tus API keys.", margen="0 0 24px")
        + boton("Revisar el método de pago", url_facturacion)
        + raya()
        + nota("Puedes recargar a mano y volver a activar la recarga automática cuando "
               "quieras desde Ajustes → Facturación.")
    )
    texto = (
        "No pudimos recargar tu saldo\n\n"
        "No pudimos cobrar la recarga automática de tu saldo de créditos, así que la "
        "desactivamos para no seguir intentándolo contra una tarjeta que el banco "
        "rechaza.\n\n"
        f"Recarga: {pack_nombre}\n\n"
        "Tu plan y tus conversaciones no se ven afectados. Lo que se queda sin saldo son "
        "las peticiones hechas con tus API keys.\n\n"
        "Revisa el método de pago:\n"
        f"{url_facturacion}\n"
    )
    return ("No pudimos recargar tu saldo — lixbon",
            envoltura(eyebrow="Facturación", titulo="No pudimos recargar tu saldo",
                      cuerpo_html=cuerpo),
            texto)


def _mensaje_citado(mensaje: str) -> str:
    # El texto del usuario tal cual, escapado y con sus saltos de línea.
    return caja(
        f'<div style="font-family:{TEXTO};font-size:14px;line-height:1.65;color:{TINTA};'
        f'white-space:pre-wrap;word-break:break-word;">{_esc(mensaje)}</div>'
    )


def soporte_caso(*, ticket: str, categoria: str, asunto: str, mensaje: str, correo: str,
                 nombre: str | None, plan: str | None, user_id: int | None,
                 pagina: str | None, dispositivo: str, cuando: str) -> tuple[str, str, str]:
    """El caso tal como llega al buzón de soporte. Responder va al usuario."""
    filas = [
        ("Caso", f'<span style="font-family:{MONO};">{_esc(ticket)}</span>'),
        ("Tipo", _esc(categoria)),
        ("De", _esc(f"{nombre} <{correo}>" if nombre else correo)),
        ("Cuenta", _esc(f"#{user_id} · plan {plan or '—'}") if user_id else "Sin sesión"),
        ("Cuándo", _esc(cuando)),
        ("Desde", _esc(dispositivo)),
    ]
    if pagina:
        filas.append(("Página", _esc(pagina)))
    cuerpo = (
        datos(filas)
        + raya("24px 0 18px")
        + _mensaje_citado(mensaje)
        + parrafo("Responde a este correo para contestarle directamente.",
                  tamano=13, color=APAGADO, margen="18px 0 0")
    )
    texto = (
        f"[{ticket}] {categoria}: {asunto}\n"
        f"De: {nombre + ' ' if nombre else ''}<{correo}>\n"
        f"Cuenta: {'#' + str(user_id) if user_id else 'sin sesión'} · plan {plan or '—'}\n"
        f"Cuándo: {cuando}\nDesde: {dispositivo}\n"
        + (f"Página: {pagina}\n" if pagina else "")
        + f"\n{mensaje}\n"
    )
    return (f"[{ticket}] {categoria} — {asunto}",
            envoltura(eyebrow=f"Soporte · {categoria}", titulo=asunto, cuerpo_html=cuerpo),
            texto)


def soporte_acuse(*, ticket: str, categoria: str, asunto: str, mensaje: str) -> tuple[str, str, str]:
    """El acuse que recibe el usuario: número de caso y copia de lo que envió."""
    cuerpo = (
        parrafo("Recibimos tu mensaje y ya está con el equipo. Te respondemos a este mismo "
                "correo, normalmente en menos de 24 horas hábiles.")
        + datos([
            ("Caso", f'<span style="font-family:{MONO};">{_esc(ticket)}</span>'),
            ("Tipo", _esc(categoria)),
            ("Asunto", _esc(asunto)),
        ])
        + raya("24px 0 18px")
        + parrafo("Lo que nos enviaste:", tamano=13, color=APAGADO, margen="0 0 10px")
        + _mensaje_citado(mensaje)
        + parrafo("Si quieres añadir algo, responde a este correo y se sumará al mismo caso.",
                  tamano=13, color=APAGADO, margen="18px 0 0")
    )
    texto = (
        f"Recibimos tu mensaje ({ticket}).\n\n"
        f"Tipo: {categoria}\nAsunto: {asunto}\n\n{mensaje}\n\n"
        "Te respondemos a este mismo correo, normalmente en menos de 24 horas hábiles.\n"
    )
    return (f"Recibimos tu mensaje [{ticket}] — lixbon",
            envoltura(eyebrow="Soporte", titulo="Tenemos tu caso", cuerpo_html=cuerpo),
            texto)
