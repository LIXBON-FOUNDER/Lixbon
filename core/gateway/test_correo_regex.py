"""Las regex de correo de registro y soporte no deben tener backtracking cuadrático:
una cadena larga que falla al final (p. ej. un espacio) bloqueaba el servidor segundos."""
import time

import pytest

from core.gateway.routers.auth import _EMAIL_RE
from core.gateway.routers.support import _CORREO


@pytest.mark.parametrize("rx", [_EMAIL_RE, _CORREO], ids=["auth", "support"])
class TestCorreo:
    @pytest.mark.parametrize("correo", [
        "a@b.co",
        "user.name+tag@sub.dominio.com",
        "a@b.c.d",
        "x_y-z@mail.example.org",
    ])
    def test_acepta_correos_normales(self, rx, correo):
        assert rx.fullmatch(correo)

    @pytest.mark.parametrize("correo", [
        "",
        "sin-arroba.com",
        "a@b",
        "a@b.",
        "a@.com",
        "a@b..com",
        "a b@c.com",
        "a@b.com ",
        "a@@b.com",
    ])
    def test_rechaza_lo_que_no_es_un_correo(self, rx, correo):
        assert not rx.fullmatch(correo)

    @pytest.mark.parametrize("hostil", [
        lambda n: "!@!." + "!." * n + " ",
        lambda n: "a@" + "b." * n + "@",
    ])
    def test_cadena_larga_hostil_es_rapida(self, rx, hostil):
        s = hostil(16000)  # con el patrón anterior, ~3 s; ahora, milisegundos
        t = time.perf_counter()
        assert not rx.fullmatch(s)
        assert time.perf_counter() - t < 0.5
