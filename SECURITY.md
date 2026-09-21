# Política de seguridad

## Reportar una vulnerabilidad

**No abras un issue público.** Usa el canal privado de GitHub:
*Security → Report a vulnerability* en este repositorio. Si no está habilitado,
contacta al mantenedor por el correo que figura en su perfil de GitHub.

Incluye: componente afectado (gateway, web, desktop, cli, mobile, node agent),
versión o commit, pasos para reproducir y el impacto que ves. Recibirás
respuesta en un plazo razonable y aviso cuando el parche esté desplegado.

## Qué se considera en alcance

- Gateway y API (`core/`): autenticación, API keys, límites de plan, aislamiento entre cuentas, panel admin.
- Comunicación gateway ↔ nodos GPU (`NODE_SHARED_SECRET`, enlace WebSocket, enrolamiento).
- Clientes: manejo de credenciales en desktop, CLI (`~/.lixbon`) y móvil (Keystore), actualizador del desktop, instaladores servidos por el gateway.
- Herramientas del agente (CLI y desktop): ejecución de comandos y edición de archivos fuera del workspace aprobado.

## Fuera de alcance

- Vulnerabilidades en Ollama o en los modelos en sí.
- Ataques que requieren acceso físico a la máquina del usuario o del nodo.
- Denegación de servicio por volumen contra la instancia pública.

## Prácticas del proyecto

- Ollama nunca se expone a internet: siempre detrás de `node_agent`.
- Secretos solo por variables de entorno (`.env` está ignorado; `.env.example` no lleva valores reales).
- Contraseñas con `scrypt`, API keys con prefijo `lixbon_sk_` almacenadas con hash, sesiones con expiración.
- Rate limiting por IP y por cuenta; bloqueo temporal en intentos de login fallidos.
- Los instaladores del desktop van firmados (`tauri-plugin-updater` verifica la firma con la clave pública embebida).
- Los tokens de admin (`ADMIN_TOKEN`) y de nodos solo viven en secrets de Railway/GitHub.

## Versiones con soporte

Solo la última versión publicada de cada producto (desktop, CLI, móvil) y el
gateway desplegado en `master` reciben parches.
