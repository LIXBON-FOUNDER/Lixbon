@echo off
:: Inicia el Gateway LIXBON DTC
cd /d "%~dp0"
set PYTHONPATH=%~dp0
python -m uvicorn core.gateway.app:app --host 0.0.0.0 --port 8000

