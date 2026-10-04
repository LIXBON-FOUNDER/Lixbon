# Worker de render de Visuals

Convierte las piezas HTML de Visuals (las que llevan `<meta name="render" content="image 1080x1350">` o `"video 1080x1920 12"`) en PNG o MP4 y guarda el resultado como versión nueva del visual. Código en `core/render/` y cola en `core/persistence/visual_renders.py`.

## Cómo funciona

1. El gateway encola un trabajo en `visual_render_jobs` cuando alguien pulsa «Renderizar», cuando un agente llama a la herramienta MCP `visual_render`, o solo, cuando se edita una pieza que ya tenía salida.
2. El worker reclama el trabajo más antiguo con un arrendamiento de 5 minutos (`SELECT … FOR UPDATE SKIP LOCKED`). Si muere a medias, el trabajo vuelve a la cola al vencer el arrendamiento. Máximo 3 intentos.
3. Renderiza con Chromium y ffmpeg, guarda la salida con el sha256 del HTML del que sale (así la web sabe si quedó desactualizada) y avisa al gateway, que avisa en vivo a la web y al IDE.

## Seguridad

El HTML es contenido de usuarios y agentes que corre en el servidor. El renderizador:
- solo deja salir peticiones http(s) a IPs públicas: nada de la red privada de Railway, metadatos de la nube ni localhost;
- solo lee archivos de la propia pieza y del directorio de assets de marca;
- limita el tamaño (máx. 4320 px por lado) y la duración (máx. 60 s de vídeo);
- corre Chromium como usuario sin privilegios (`pwuser`).

## Desplegar en Railway

Servicio `render-worker` en el proyecto `marvelous-expression` (entorno `production`). **No está conectado a GitHub**: el `railway.toml` de la raíz es del gateway y Railway lo impone a todo servicio conectado al repo, y ya no permite asignar otro archivo por servicio. Se despliega con:

```bash
bash infra/render_worker/deploy.sh
```

que sube una carpeta con solo `core/`, `requirements.txt`, las fuentes de marca y este Dockerfile. Hay que volver a ejecutarlo cuando cambie `core/` o `requirements.txt` (el worker no se actualiza solo con cada push).

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{Lixbon-prod.DATABASE_URL}}` (referencia a la base de datos del gateway) |
| `RENDER_GATEWAY_URL` | `https://lixbon.com`, para los avisos en vivo |
| `RENDER_WORKER_TOKEN` | secreto compartido; el servicio `Lixbon` (gateway) tiene **el mismo** valor |
| `RENDER_POLL_S` | opcional, segundos entre consultas a la cola vacía (2 por defecto) |

Sin `RENDER_GATEWAY_URL`/`RENDER_WORKER_TOKEN` el render funciona igual, pero la web solo ve el resultado al recargar.

Para varias réplicas basta con subir el número de instancias: la cola reparte los trabajos.

Railway retira los `railway.toml` (Config as Code) el 2026-12-01; antes hay que migrar a `.railway/railway.ts` (`railway config migrate`), también el del gateway.

## Desarrollo local

`RENDER_INLINE=1` hace que el gateway procese la cola en un hilo propio. En Windows sin `playwright install` usa Edge. ffmpeg sale del sistema o de `imageio-ffmpeg`.

## Pendiente de verificar

- Las cuotas diarias de render (Pro 100 imágenes y 10 vídeos, Advance 500 y 50) son **provisionales** (`core/billing/quota.py`); se ajustan por plan en las columnas `visual_renders_per_day` y `visual_video_renders_per_day`.
