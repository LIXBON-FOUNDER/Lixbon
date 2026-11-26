# LXR-23 · Ubicación del modo Diseño

Estado: propuesta pendiente de la decisión del fundador. Fecha: 25 de noviembre de 2026.

La issue pide decidir dónde vive Diseño antes de sustituir el modo actual por el tablero `IdeNuevoDiseno`. Esta nota no autoriza una migración ni cambia la navegación existente.

| Opción | Qué se reutiliza | Ventaja | Coste |
| --- | --- | --- | --- |
| Mantener Diseño en el IDE | `DesignMode.jsx`, `DesignInspector.jsx`, el servidor del proyecto, la selección de archivos, los dispositivos y el panel del agente | Permite editar y comprobar la aplicación local junto a su código y conserva Ctrl 3 | Hay que implementar las capas y el inspector del tablero sobre el puente local y mantener esa superficie |
| Unirlo a Visuals de la web | `VisualsPage.jsx`, `VisualsPanels.jsx`, las versiones, los archivos y la API de Visuals | Centraliza la edición de piezas visuales y sus versiones en el producto web | Hace falta definir cómo una aplicación local, su servidor y sus cambios de código se vinculan con un visual; no basta con mover el botón |

Recomendación: mantener Diseño en el IDE para trabajar sobre aplicaciones locales. Visuals puede seguir siendo el espacio de piezas visuales versionadas. Ambos pueden compartir primitivas y convenciones sin mezclar sus identidades ni trasladar archivos automáticamente.

La razón se apoya en el código actual: el modo Desktop usa el proyecto abierto, su servidor y la emulación de dispositivos; Visuals trabaja con piezas, versiones y archivos guardados en su API. La unificación de esas dos unidades de trabajo necesita una decisión de producto y un contrato de transferencia adicional.

Mientras se decide, se conserva el modo actual con sus dispositivos, vista del proyecto, agente e inspector. Si se aprueba mantenerlo en el IDE, se debe crear la issue de implementación a partir de `IdeNuevoDiseno`, incluyendo las funciones existentes que se conservan. Si se aprueba la unión, se debe acordar primero el flujo del proyecto local hacia Visuals.

Decisión del fundador: pendiente. No se ha supuesto una elección.
