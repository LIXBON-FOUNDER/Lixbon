from __future__ import annotations

import html

TIPO = "'Bricolage Grotesque', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MARCA = "'Bruno Ace SC', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif"
MONO = "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace"

CREMA = "#f2f1e3"
BLANCO = "#ffffff"
BORDE = "#e4dfce"
BORDE_TENUE = "#e9e5d6"
TINTA = "#1b1a17"
TINTA_SUAVE = "#5b584f"
APAGADO = "#a79e86"
OLIVO = "#6c7a46"
CREMA_CAJA = "#f7f6ee"


def _esc(v: object) -> str:
    return html.escape(str(v or ""), quote=True)


def boton(texto: str, url: str) -> str:
    return (
        f'<a href="{_esc(url)}" style="display:inline-block;background:{TINTA};color:{CREMA};'
        f'font-family:{TIPO};font-size:15px;font-weight:600;line-height:1;padding:15px 32px;'
        f'border-radius:999px;text-decoration:none;">{_esc(texto)}</a>'
    )


def parrafo(texto_html: str, tamano: int = 15, color: str = TINTA_SUAVE, margen: str = "0 0 22px") -> str:
    return (
        f'<p style="margin:{margen};font-family:{TIPO};font-size:{tamano}px;'
        f'line-height:1.65;color:{color};">{texto_html}</p>'
    )


def caja(contenido_html: str, relleno: str = "18px 20px") -> str:
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background:{CREMA_CAJA};border:1px solid {BORDE};border-radius:16px;">'
        f'<tr><td style="padding:{relleno};">{contenido_html}</td></tr></table>'
    )


def filas_dato(pares: list[tuple[str, str]]) -> str:
    filas = []
    for i, (etiqueta, valor) in enumerate(pares):
        ultima = i == len(pares) - 1
        borde = "" if ultima else f"border-bottom:1px solid {BORDE_TENUE};"
        filas.append(
            f'<tr>'
            f'<td style="padding:11px 0;{borde}font-family:{TIPO};font-size:12.5px;'
            f'color:{APAGADO};white-space:nowrap;vertical-align:top;width:96px;">{_esc(etiqueta)}</td>'
            f'<td style="padding:11px 0;{borde}font-family:{TIPO};font-size:13.5px;'
            f'color:{TINTA};vertical-align:top;">{valor}</td>'
            f'</tr>'
        )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        + "".join(filas) + "</table>"
    )


def envoltura(*, eyebrow: str, titulo: str, cuerpo_html: str, pie_html: str = "") -> str:
    pie = pie_html or (
        f'Enviado por lixbon desde no-reply@lixbon.com. Este buzón no admite respuestas.'
    )
    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>{_esc(titulo)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bruno+Ace+SC&amp;family=Bricolage+Grotesque:opsz,wght@12..96,400..700&amp;display=swap">
</head>
<body style="margin:0;padding:0;background:{CREMA};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:{CREMA};">
<tr><td align="center" style="padding:30px 16px 34px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="584" style="width:584px;max-width:100%;">

<tr><td style="padding:0 8px 18px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td align="left" style="font-family:{MARCA};font-size:15px;letter-spacing:0.06em;color:{TINTA};">lixbon</td>
    <td align="right" style="font-family:{TIPO};font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:{APAGADO};">{_esc(eyebrow)}</td>
  </tr></table>
</td></tr>

<tr><td style="background:{BLANCO};border:1px solid {BORDE};border-radius:22px;padding:36px 34px 32px;">
  <h1 style="margin:0 0 14px;font-family:{TIPO};font-size:27px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:{TINTA};">{_esc(titulo)}</h1>
  {cuerpo_html}
</td></tr>

<tr><td style="padding:20px 10px 0;font-family:{TIPO};font-size:11.5px;line-height:1.6;color:{APAGADO};">{pie}</td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


def raya(margen: str = "28px 0 20px") -> str:
    return f'<div style="height:1px;background:{BORDE};margin:{margen};font-size:0;line-height:0;">&nbsp;</div>'


def nota(texto: str) -> str:
    return parrafo(_esc(texto), tamano=13, color=APAGADO, margen="0")


def _producto(titulo: str, descripcion: str) -> str:
    return (
        f'<tr><td style="padding:0 0 16px;">'
        f'<p style="margin:0 0 3px;font-family:{TIPO};font-size:14.5px;font-weight:600;color:{TINTA};">{_esc(titulo)}</p>'
        f'<p style="margin:0;font-family:{TIPO};font-size:13.5px;line-height:1.55;color:{TINTA_SUAVE};">{_esc(descripcion)}</p>'
        f'</td></tr>'
    )


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
        + f'<p style="margin:0 0 10px;font-family:{TIPO};font-size:13px;font-weight:600;color:{TINTA_SUAVE};">¿El botón no funciona?</p>'
        + f'<div style="background:{CREMA_CAJA};border:1px solid {BORDE};border-radius:12px;'
          f'padding:12px 14px;font-family:{MONO};font-size:12px;line-height:1.55;'
          f'color:{TINTA_SUAVE};word-break:break-all;">{_esc(url)}</div>'
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
    productos = (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        + _producto("Chat en lixbon.com", "Habla con los modelos desde el navegador, sin instalar nada.")
        + _producto("Lixbon IDE", "El editor de escritorio, con la IA trabajando dentro de tu proyecto.")
        + _producto("Lixbon CLI", "La terminal, para guiones y tareas que se repiten.")
        + "</table>"
    )
    bloque_plan = caja(
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
        f'<td align="left" style="font-family:{TIPO};font-size:14px;font-weight:600;color:{TINTA};">Plan {_esc(plan_nombre)}</td>'
        f'<td align="right"><a href="{_esc(url_planes)}" style="font-family:{TIPO};font-size:12.5px;'
        f'font-weight:500;color:{OLIVO};text-decoration:none;">Ver planes</a></td>'
        f'</tr></table>'
        f'<p style="margin:5px 0 0;font-family:{TIPO};font-size:13px;line-height:1.55;color:{TINTA_SUAVE};">{_esc(plan_limites)}</p>',
        relleno="16px 18px",
    )
    cuerpo = (
        parrafo("Tu correo quedó confirmado. La misma cuenta abre los tres sitios donde "
                "vive lixbon, sin configurar nada más.", margen="0 0 26px")
        + productos
        + _hueco(10)
        + bloque_plan
        + _hueco(26)
        + boton("Abrir lixbon", url)
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
            envoltura(eyebrow="Cuenta creada", titulo="Ya estás dentro", cuerpo_html=cuerpo),
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
                margen="0 0 24px")
        + caja(filas_dato(pares), relleno="6px 18px")
        + _hueco(26)
        + parrafo(f'<strong style="font-weight:600;color:{TINTA};">¿No reconoces este acceso?</strong> '
                  "Cambia la contraseña ahora. Al hacerlo se cierran todas las demás sesiones "
                  "y se revocan las claves de API activas.", margen="0 0 18px")
        + boton("Proteger mi cuenta", url_proteger)
        + raya()
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
                      pie_html="Este aviso es de seguridad: se envía siempre y no se puede desactivar."),
            texto)


def suscripcion(*, plan_nombre: str, precio: str, limites: list[str],
                renovacion: str | None, url: str) -> tuple[str, str, str]:
    celdas: list[str] = []
    for i, limite in enumerate(limites):
        if i % 2 == 0:
            celdas.append("<tr>")
        celdas.append(
            f'<td width="50%" style="padding:0 8px 11px 0;font-family:{TIPO};font-size:13.5px;'
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
        f'<td align="left" style="padding-bottom:14px;font-family:{TIPO};font-size:17px;font-weight:600;color:{TINTA};">{_esc(plan_nombre)}</td>'
        f'<td align="right" style="padding-bottom:14px;font-family:{TIPO};font-size:15px;font-weight:600;color:{TINTA};">'
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
        + f'<p style="margin:0 0 10px;font-family:{TIPO};font-size:13px;font-weight:600;color:{TINTA_SUAVE};">¿El botón no funciona?</p>'
        + f'<div style="background:{CREMA_CAJA};border:1px solid {BORDE};border-radius:12px;'
          f'padding:12px 14px;font-family:{MONO};font-size:12px;line-height:1.55;'
          f'color:{TINTA_SUAVE};word-break:break-all;">{_esc(url)}</div>'
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
        + caja(filas_dato(pares), relleno="6px 18px")
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
        f'<p style="margin:0 0 7px;font-family:{TIPO};font-size:13.5px;line-height:1.45;'
        f'color:{TINTA_SUAVE};"><span style="color:{OLIVO};font-weight:700;">·</span>&nbsp;{_esc(l)}</p>'
        for l in limites_gratis
    )
    bloque = caja(
        f'<p style="margin:0 0 12px;font-family:{TIPO};font-size:14px;font-weight:600;'
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
        + caja(filas_dato(pares), relleno="6px 18px")
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
