"""Nodos por conexión inversa en el orquestador. Sin red ni BD: se inyecta `_estado`."""
from core.orchestration.orchestrator import NodeOrchestrator


def _config(nid, agent_url=None):
    return {"id": nid, "name": nid, "agent_url": agent_url, "token": "s3cret", "enabled": True}


def _orq(*configs):
    orq = NodeOrchestrator()
    for cfg in configs:
        orq._estado[cfg["id"]] = {
            "online": False, "fallos": 0, "next_retry": 0.0, "metricas": {}, "modelos": [],
            "capabilities": {}, "tamanos": {}, "agent_version": None, "hostname": None,
            "score": 0.0, "ultimo_poll": None, "config": cfg,
        }
    return orq


METRICAS = {
    "cpu_percent": 10, "ram_percent": 20, "gpu_free_percent": 90, "hostname": "pod-1",
    "models": ["qwen3:8b"], "model_info": [{"name": "qwen3:8b", "size": 5, "capabilities": ["tools"]}],
    "agent_version": "4.0.0",
}


def test_conexion_y_metricas_ponen_el_nodo_online():
    orq = _orq(_config("gpu-a1"))
    assert orq.nodo_conectado("gpu-a1", {"agent_version": "4.0.0", "hostname": "pod-1"})
    assert orq.nodos_online() == ["gpu-a1"]

    orq.actualizar_metricas("gpu-a1", METRICAS)
    est = orq._estado["gpu-a1"]
    assert est["modelos"] == ["qwen3:8b"]
    assert est["capabilities"] == {"qwen3:8b": ["tools"]}
    assert est["score"] > 0
    assert orq.estado_nodos()[0]["mode"] == "link"
    assert orq.estado_nodos()[0]["hostname"] == "pod-1"


def test_ollama_target_devuelve_esquema_node():
    orq = _orq(_config("gpu-a1"), _config("gpu-01", "https://gpu-01.lixbon.com"))
    orq.nodo_conectado("gpu-a1")
    orq.actualizar_metricas("gpu-a1", METRICAS)
    base, headers, origen = orq.ollama_target("qwen3:8b", strict=True)
    assert (base, headers, origen) == ("node://gpu-a1", {}, "gpu-a1")


def test_desconexion_deja_offline_y_las_metricas_tardias_se_ignoran():
    orq = _orq(_config("gpu-a1"))
    orq.nodo_conectado("gpu-a1")
    orq.nodo_desconectado("gpu-a1")
    assert orq.nodos_online() == []
    orq.actualizar_metricas("gpu-a1", METRICAS)
    assert orq.nodos_online() == []


def test_un_nodo_por_url_no_acepta_conexion_inversa():
    orq = _orq(_config("gpu-01", "https://gpu-01.lixbon.com"))
    assert orq.nodo_conectado("gpu-01") is False
    assert orq.nodos_online() == []


def test_poll_ignora_nodos_link():
    orq = _orq(_config("gpu-a1"))
    orq._poll_nodo(_config("gpu-a1"))
    assert orq._estado["gpu-a1"]["fallos"] == 0
