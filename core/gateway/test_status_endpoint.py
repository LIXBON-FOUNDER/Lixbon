"""/api/status: público, agrega el estado vivo con las muestras guardadas y
saca incidentes de las rachas y de los huecos entre muestras. SQLite temporal."""
import os
import pathlib
import tempfile
from datetime import datetime, timedelta, timezone

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_status_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'status.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.routers import status as st  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine  # noqa: E402

T0 = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)


def _muestras(estados, paso=st.SAMPLE_INTERVAL_S):
    return [((T0 + timedelta(seconds=paso * i)).isoformat(), e) for i, e in enumerate(estados)]


def _todo(estado="operational"):
    return {c["id"]: estado for c in st.COMPONENTES}


def test_historial_racha_es_un_incidente():
    caida = {**_todo(), "inference": "down"}
    muestras = _muestras([_todo(), caida, caida, _todo()])
    ahora = st._parse(muestras[-1][0]) + timedelta(seconds=60)
    h = st.historial(muestras, ahora=ahora, days=1)
    incidentes = [i for i in h["incidents"] if i["component"] == "inference"]
    assert len(incidentes) == 1
    assert incidentes[0]["started_at"] == muestras[1][0]
    assert incidentes[0]["ended_at"] == muestras[3][0]
    assert incidentes[0]["duration_min"] == 10
    assert h["components"]["inference"]["uptime"] == 50.0
    assert h["components"]["api"]["uptime"] == 100.0
    assert h["components"]["inference"]["days"][-1]["status"] == "down"


def test_historial_hueco_entre_muestras_es_caida_de_api():
    muestras = _muestras([_todo(), _todo()])
    tarde = (T0 + timedelta(hours=2)).isoformat()
    muestras.append((tarde, _todo()))
    h = st.historial(muestras, ahora=st._parse(tarde) + timedelta(seconds=30), days=1)
    api = [i for i in h["incidents"] if i["component"] == "api"]
    assert len(api) == 1 and api[0]["ended_at"] == tarde
    assert h["components"]["api"]["uptime"] < 100


def test_historial_unavailable_no_cuenta_como_caida():
    muestras = _muestras([{**_todo(), "images": "unavailable"}] * 3)
    h = st.historial(muestras, ahora=st._parse(muestras[-1][0]), days=1)
    assert h["incidents"] == []
    assert h["components"]["images"]["uptime"] == 100.0


@pytest.fixture(scope="module")
def cliente():
    Base.metadata.create_all(get_engine())
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    app_mod.status.start_sampler = lambda: None
    app_mod.deps.orquestador.estado_nodos = lambda: [
        {"id": "n1", "online": True, "modelos": ["qwen3:8b"], "metricas": {}},
        {"id": "n2", "online": False, "modelos": [], "metricas": {}},
    ]
    with TestClient(app_mod.app) as c:
        yield c


def test_status_es_publico_y_agrega_todo(cliente):
    q.add_status_sample({**_todo(), "inference": "degraded"})
    r = cliente.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded"
    por_id = {c["id"]: c for c in body["components"]}
    assert por_id["inference"]["status"] == "degraded"
    assert por_id["inference"]["detail"] == "1 de 2 nodos, 1 modelos"
    assert por_id["database"]["status"] == "operational"
    assert por_id["images"]["status"] == "unavailable"
    assert por_id["payments"]["status"] == "unavailable"
    assert len(por_id["api"]["days"]) == body["history_days"] == 90
    assert por_id["inference"]["uptime"] == 0.0
    assert body["incidents"][0]["component"] == "inference"
    assert body["incidents"][0]["ended_at"] is None
