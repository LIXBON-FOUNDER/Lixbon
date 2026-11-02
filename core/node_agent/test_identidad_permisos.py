"""
La identidad del nodo (`node_id` + `secret`) se guarda en disco. El secreto no
debe quedar legible por otros usuarios ni siquiera un instante.
"""
import os
import stat
import sys

import pytest

from core.node_agent import agent

solo_posix = pytest.mark.skipif(sys.platform == "win32", reason="los bits de permiso son de POSIX")


@pytest.fixture
def estado(tmp_path, monkeypatch):
    ruta = tmp_path / ".lixbon" / "node.json"
    monkeypatch.setattr(agent, "STATE_FILE", ruta)
    return ruta


def test_guardar_y_leer_identidad(estado):
    datos = {"gateway": "https://g", "node_id": "n1", "secret": "s3creto"}
    agent._guardar_identidad(datos)
    assert agent._leer_identidad() == datos


def test_guardar_reemplaza_el_contenido_anterior(estado):
    agent._guardar_identidad({"node_id": "n1", "secret": "x" * 200})
    agent._guardar_identidad({"node_id": "n2", "secret": "y"})
    assert agent._leer_identidad() == {"node_id": "n2", "secret": "y"}


@solo_posix
def test_archivo_nuevo_nace_con_0600(estado):
    agent._guardar_identidad({"node_id": "n1", "secret": "s"})
    assert stat.S_IMODE(os.stat(estado).st_mode) == 0o600


@solo_posix
def test_archivo_existente_mas_abierto_se_restringe(estado):
    estado.parent.mkdir(parents=True)
    estado.write_text("{}")
    os.chmod(estado, 0o644)
    agent._guardar_identidad({"node_id": "n1", "secret": "s"})
    assert stat.S_IMODE(os.stat(estado).st_mode) == 0o600
