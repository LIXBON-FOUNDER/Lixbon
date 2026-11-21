# Desktop F6 — LXO-32

Desktop recibe `lixbon://` con el plugin oficial de Tauri. Single Instance entrega los enlaces a la ventana existente; el listener se instala antes de leer los enlaces de arranque. La configuración del bundle registra el esquema en Windows/macOS; Linux registra también la entrada de usuario para AppImage/desarrollo. Solo `main` puede leer los enlaces del plugin.

Todos los destinos pasan por `deep_link_resolve`. Un enlace obsoleto muestra ambas revisiones y requiere elegir explícitamente la actual. Activity, Review, Diff y Artifacts conservan su Attempt; el lector de diff por Task comprueba que no haya un Attempt posterior y verifica el HEAD solicitado. Los archivos se abren únicamente después de resolver su ubicación local con Core.

## Workspace y propiedad

`attempt_workspace {attempt_id,file?}` y `project_workspace {project_id,file?}` son lecturas autenticadas. La ubicación procede del almacén, nunca de un URL. Core verifica host, presencia y contención canónica de los archivos, incluidos enlaces simbólicos. No admiten un `root` del cliente.

Abrir workspace desde ADE es explícito. Conserva pestañas y cambios sin guardar, recuerda el archivo activo por raíz y la URL de navegador elegida por Attempt y asigna a cada terminal su cwd al crearlo. El indicador de Task/Attempt, rama y host acompaña al editor, terminal y navegador. Cambiar de Attempt limpia una URL heredada hasta elegir o restaurar la de ese contexto. Un resultado de Delegate/Handoff no cambia el workspace. El IDE consulta `work_at` sobre el vínculo verificado, muestra dueño, candidatos y evidencia incompleta; no convierte un Attempt histórico en propietario. Un workspace abierto fuera de ADE se identifica como no vinculado hasta abrir explícitamente el Attempt correspondiente.

El sidecar se vincula por elección explícita a un Attempt. Reutiliza Activity, Queue/Steer/Stop, capacidades y sesión opaca del Core. Mantiene sus borradores al cambiar de archivo, cerrar o alternar entre sidecars; adjuntar contexto añade una referencia canónica verificada. Review inline reutiliza Proof Pack y `attempt_review`, con decisión sobre el HEAD mostrado; no incluye integración ni un segundo chat.

## Control y transferencias

Take Over espera el cambio de propiedad confirmado por Core antes de abrir el workspace. Return muestra commits, archivos y cambios sin commit comprobados, y conserva los avisos de evidencia incompleta. Un fallo mantiene la propiedad que Core informa; no hay devolución automática ni otro Attempt.

Delegate exige receptor explícito, encargo, perfil y confirmación de Task nueva cuando existe origen. Handoff continúa la misma Task con un Attempt nuevo y conserva el perfil. Ambos muestran un ContextPackage construido y verificado por Core antes de confirmar. El origen de una selección queda fijado al abrir el formulario; editar otro archivo no lo cambia. Core determina host y estrategia de worktree: estas versiones de sus comandos no aceptan otras selecciones. Un fallo conserva el formulario y paquete; abrir el resultado es otra acción explícita.

## Validación

Vitest cubre la espera de la frontera segura, fallo de Take Over, selección explícita del receptor, verificación del paquete, origen fijo, conservación de foco y revisión obsoleta. Las pruebas Rust usan Core y repositorios reales para existencia, autorización antes de validar, host ajeno, rutas peligrosas y archivos fuera del workspace; la prueba de symlink se ejecuta en Unix.

La aceptación manual debe comprobar el instalador/protocolo en Windows, macOS y Linux, enlaces con la aplicación cerrada/abierta, accesibilidad con teclado y un proveedor real para Take Over/Return. Las suites automatizadas no sustituyen esas comprobaciones.
