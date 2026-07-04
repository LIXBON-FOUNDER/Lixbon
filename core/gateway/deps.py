"""
deps.py — Singletons compartidos entre routers de FOLAX DTC.
Los clientes HTTP se inicializan en el evento on_startup de main.py.
"""
from __future__ import annotations
import httpx
from core.orchestration.orchestrator import NodeOrchestrator

# Instancia única del orquestador de nodos LAN
orquestador: NodeOrchestrator = NodeOrchestrator()

# Clientes HTTP async compartidos (se asignan en app startup)
http_client_fast: httpx.AsyncClient | None = None
http_client_chat: httpx.AsyncClient | None = None
