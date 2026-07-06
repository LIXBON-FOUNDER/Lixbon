# LIXBON DTC — Data & Task Center v2.0

Orquestador corporativo y pasarela API para exponer y coordinar modelos de `Ollama` en una red LAN, con balanceo de carga, circuit breaker y delegación inteligente.

- **Orquestación & Balanceo de Carga**: Selección automática del mejor nodo de la red local según uso de CPU, RAM y GPU.
- **Circuit Breaker Inteligente**: Aislamiento temporal de nodos caídos con backoff exponencial.
- **Seguridad Robusta**: Hashing de contraseñas con `scrypt` y rate limiting configurable.
- **Delegación Inteligente**: Enrutamiento automático de solicitudes usando embeddings de historial.
- **Lanzador Unificado**: Control del stack completo desde un único menú interactivo (`LIXBON.bat` / `LIXBON.sh`).
- **Dashboard Web**: Panel de administración premium para monitorizar el estado del cluster, audit logs y API keys.

---

## 🚀 Instalación y Despliegue Rápido

### 1. Clonar e Instalar Dependencias
```bash
# Crear entorno virtual
python3 -m venv .venv
source .venv/bin/activate  # o .venv\Scripts\activate en Windows

# Instalar dependencias
pip install -r requirements.txt
```

### 2. Configurar Entorno
Copia el archivo `.env.example` como `.env` y edita los valores si es necesario:
```bash
cp .env.example .env
```

### 3. Iniciar con el Lanzador Unificado
En lugar de abrir múltiples terminales, usa el script maestro:

- **Windows**: Ejecuta `LIXBON.bat`
- **Linux / macOS**: Ejecuta `./LIXBON.sh`

El menú interactivo te permitirá arrancar el Gateway, el Node Agent local, Ollama en modo LAN y el túnel de Cloudflare de forma unificada.

- **Dashboard**: `http://localhost:8000/`
- **Health**: `http://localhost:8000/health`

---

## 💻 Cliente CLI de LIXBON DTC

Se incluye un potente cliente CLI en `client_cli.py` para chatear y ejecutar comandos de agente desde cualquier máquina de la red.

### Instalación en Equipos Remotos

Con el Gateway activo, ejecuta en la máquina cliente:

#### Linux / macOS
```bash
curl -fsSL "http://IP_DEL_SERVIDOR:8000/install.sh" | bash
```

#### Windows (PowerShell)
```powershell
irm "http://IP_DEL_SERVIDOR:8000/install.ps1" | iex
```

### Comandos del CLI

Abre una nueva terminal y ejecuta:

1. **Configuración inicial**:
   ```bash
   LIXBON setup
   ```
2. **Iniciar chat interactivo**:
   ```bash
   LIXBON chat
   ```
3. **Ver estado del cluster**:
   ```bash
   LIXBON status
   ```

#### Slash Commands dentro del Chat del CLI
- `/nodes` — Muestra el estado en tiempo real de todos los nodos del cluster, su score y si están en circuit breaker.
- `/model <nombre>` — Cambia el modelo en caliente.
- `/mode ask|agent` — Cambia entre modo chat y modo agente autónomo.
- `/workspace <ruta>` — Define el directorio de trabajo para edición de código local.
- `/approve on|off` — Activa/desactiva aprobación manual de herramientas.
- `/usage` — Muestra el consumo global de tokens y mensajes.
- `/update` — Actualiza el CLI directamente desde el servidor.
- `/exit` — Salir del chat.

---

## 🛠️ Integraciones API (Formato OpenAI)

El Gateway es 100% compatible con la especificación de API de OpenAI:

### curl
```bash
curl -X POST "http://IP_DEL_SERVIDOR:8000/v1/chat/completions" \
  -H "Authorization: Bearer TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [{"role": "user", "content": "Hola"}],
    "client_id": "pc-diseno-01"
  }'
```

### n8n
- **Nodo**: `OpenAI Chat Model`
- **Base URL**: `http://IP_DEL_SERVIDOR:8000/v1`
- **API Key**: Generada desde el dashboard
- **Modelo**: Nombre exacto de Ollama
