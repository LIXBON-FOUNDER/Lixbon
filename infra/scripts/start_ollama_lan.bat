@echo off
:: Inicia Ollama con OLLAMA_HOST para que escuche en red LAN
:: Copiar este archivo a:
::   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
set OLLAMA_HOST=0.0.0.0:11434
start "" ollama serve
