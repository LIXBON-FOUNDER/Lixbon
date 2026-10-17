"""Resumen del clúster para el panel admin: nodos en línea, VRAM y peticiones.
Sin red ni BD: se inyecta el estado del orquestador."""
from core.orchestration.orchestrator import VENTANA_PETICIONES, NodeOrchestrator


def _orq(*nodos):
    orq = NodeOrchestrator()
    for nid, online, metricas in nodos:
        orq._estado[nid] = {
            "online": online, "fallos": 0, "next_retry": 0.0, "metricas": metricas, "modelos": [],
            "capabilities": {}, "tamanos": {}, "agent_version": None, "hostname": None,
            "score": 0.0, "ultimo_poll": None, "config": {"id": nid},
        }
    return orq


def _gpu(total, libre, uso):
    return {"gpu_available": True, "gpu_total_mb": total, "gpu_free_mb": libre, "gpu_used_percent": uso}


def test_suma_la_vram_solo_de_los_nodos_en_linea_con_gpu():
    orq = _orq(
        ("gpu-01", True, _gpu(24576, 10240, 60)),
        ("gpu-02", True, _gpu(81920, 40960, 20)),
        ("gpu-03", False, _gpu(24576, 24576, 0)),   # caído: su VRAM no está disponible
        ("cpu-01", True, {"gpu_available": False, "gpu_total_mb": 0.0, "gpu_free_mb": 0.0}),
    )
    r = orq.resumen_cluster(ahora=1000.0)
    assert r["nodes_total"] == 4
    assert r["nodes_online"] == 3
    assert r["gpus_online"] == 2
    assert r["vram_total_mb"] == 24576 + 81920
    assert r["vram_free_mb"] == 10240 + 40960
    assert r["vram_used_mb"] == (24576 - 10240) + (81920 - 40960)
    assert r["gpu_used_percent_avg"] == 40.0


def test_sin_nodos_todo_es_cero():
    r = _orq().resumen_cluster(ahora=1000.0)
    assert (r["nodes_total"], r["nodes_online"], r["vram_total_mb"], r["vram_free_mb"]) == (0, 0, 0, 0)
    assert r["gpu_used_percent_avg"] is None
    assert r["requests_last_minute"] == 0


def test_la_vram_libre_nunca_supera_la_total():
    orq = _orq(("gpu-01", True, _gpu(8192, 9000, 0)))
    assert orq.resumen_cluster(ahora=1000.0)["vram_free_mb"] == 8192


def test_peticiones_por_minuto_y_por_hora():
    orq = _orq()
    ahora = 10_000.0
    # Llegan en orden, como en producción: cada petición es posterior a la anterior.
    for t in sorted((ahora - 3, ahora - 30, ahora - 59, ahora - 61, ahora - 1800, ahora - VENTANA_PETICIONES - 5)):
        orq.registrar_peticion(t)
    r = orq.resumen_cluster(ahora=ahora)
    assert r["requests_last_minute"] == 3
    assert r["requests_last_hour"] == 5      # la de hace más de una hora se descarta
    assert r["requests_per_minute_avg"] == round(5 / 60, 1)
