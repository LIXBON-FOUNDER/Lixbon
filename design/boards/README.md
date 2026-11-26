# Tableros aprobados de Lixbon Design

Exportados el **2026-11-24**, desde [Lixbon Design](https://claude.ai/artifact/NvpgXNKNQGsnQ3Kb5wKdEB). Son 9 tableros IDE, 10 ADE y 24 Mobile. La exportación disponible contiene cambios v116/v117: **no es una copia histórica de v111**, versión que citan las issues. Si hay diferencias, prevalece el alcance de la issue o la aprobación del fundador.

## Abrir en local

Desde la raíz del repositorio:

```sh
python -m http.server 1426
```

Abrir http://localhost:1426/design/boards/ . También sirve `npx serve .` desde la raíz. Se sirve la raíz porque las fuentes de marca se reutilizan desde `shared/fonts`, mediante rutas relativas. No hace falta una cuenta de Claude para leer los HTML ni abrir los tableros exportados.

`ds.css` y `assets/` conservan los recursos del lienzo. La licencia de JetBrains Mono está en `assets/JetBrainsMono-LICENSE`; las fuentes de marca conservan sus licencias en `shared/fonts`. Los tableros `*Hoy*` y otros productos no se exportan; se consultan en el lienzo original como referencia de las funciones existentes.

## Actualizar una exportación aprobada

Guardar las tres exportaciones HTML de Claude (06 IDE, 05 ADE y 07 Mobile) fuera del control de versiones y ejecutar:

```sh
python design/boards/import_bundle.py --ide /ruta/ide.html --ade /ruta/ade.html --mobile /ruta/mobile.html --export-date 2026-11-24 --version "Versión aprobada del lienzo"
```

El importador decodifica los recursos sin ejecutar JavaScript, reemplaza rutas de blobs y verifica los títulos conocidos. `manifest.json` registra la procedencia, las issues y SHA-256 de originales y tableros. Revisar los cambios, abrir el índice y actualizar la fecha y versión de este documento en cada exportación aprobada.

## Correspondencia con issues

| Tablero | Issues |
| --- | --- |
| [IDE · Editor con agente](06-ide/IdeNuevoEditor.dc.html) | LXR-4, LXR-6, LXR-9 |
| [IDE · Modo Agente](06-ide/IdeNuevoAgente.dc.html) | LXR-2, LXR-3, LXR-6, LXR-7 |
| [IDE · Git y pull request](06-ide/IdeNuevoGit.dc.html) | LXR-10, LXR-4 |
| [IDE · Paleta de comandos (Ctrl K)](06-ide/IdeNuevoPaleta.dc.html) | LXR-11 |
| [IDE · Ajustes (ventana)](06-ide/IdeNuevoAjustes.dc.html) | LXR-12 |
| [IDE · Iconos de archivo](06-ide/IdeNuevoArchivos.dc.html) | LXR-4 |
| [IDE · Modo Diseño](06-ide/IdeNuevoDiseno.dc.html) | LXR-23 |
| [IDE · Decisiones de diseño](06-ide/IdeNotas.dc.html) | LXR-2 |
| [IDE · Modelo y razonamiento](06-ide/IdeNuevoModelo.dc.html) | LXR-8 |
| [ADE · Intento en marcha · Tarea](05-ade/AdeNuevoWorkspace.dc.html) | LXR-13, LXR-14, LXR-15, LXR-2, LXR-3, LXR-6 |
| [ADE · Atención (decisiones)](05-ade/AdeNuevoAtencion.dc.html) | LXR-13, LXR-16, LXR-3 |
| [ADE · Comparar intentos](05-ade/AdeNuevoComparar.dc.html) | LXR-17, LXR-4 |
| [ADE · Mapa de dependencias](05-ade/AdeNuevoMapa.dc.html) | LXR-20, LXR-4 |
| [ADE · Hosts](05-ade/AdeNuevoHosts.dc.html) | LXR-21, LXR-3 |
| [ADE · Intento para revisar · Contexto](05-ade/AdeNuevoContexto.dc.html) | LXR-13, LXR-14, LXR-18 |
| [ADE · Lanzar un intento](05-ade/AdeNuevoIntento.dc.html) | LXR-22 |
| [ADE · Inspector · Autonomía](05-ade/AdeNuevoAutonomia.dc.html) | LXR-13, LXR-18 |
| [ADE · Decisiones de diseño](05-ade/AdeNotas.dc.html) | LXR-2 |
| [ADE · Intento de Lixbon · Cambios](05-ade/AdeNuevoLixbon.dc.html) | LXR-13, LXR-14, LXR-19 |
| [Mobile · Inicio y navegación](07-mobile/MovilNavegacion.dc.html) | LXR-24, LXR-28 |
| [Mobile · Remoto](07-mobile/MovilRemoto.dc.html) | LXR-37 |
| [Mobile · Sesión · acciones](07-mobile/MovilSesionAcciones.dc.html) | LXR-33 |
| [Mobile · Chat · respuestas](07-mobile/MovilChat.dc.html) | LXR-24, LXR-29 |
| [Mobile · Sesión remota](07-mobile/MovilSesion.dc.html) | LXR-33 |
| [Mobile · Supervisar](07-mobile/MovilSupervisar.dc.html) | LXR-25, LXR-34 |
| [Mobile · Chat · escribir](07-mobile/MovilChatMenus.dc.html) | LXR-29, LXR-30 |
| [Mobile · Sesión · detalles](07-mobile/MovilDetalles.dc.html) | LXR-33 |
| [Mobile · Intento y decisiones](07-mobile/MovilIntento.dc.html) | LXR-34 |
| [Mobile · Chat · historial](07-mobile/MovilChatHistorial.dc.html) | LXR-28 |
| [Mobile · Decisiones de diseño](07-mobile/MovilNotas.dc.html) | LXR-24 |
| [Mobile · Estados · carga y conexión](07-mobile/MovilEstados.dc.html) | LXR-25, LXR-35 |
| [Mobile · Estados · error, vacío y éxito](07-mobile/MovilEstados2.dc.html) | LXR-25, LXR-38 |
| [Mobile · Uso detallado](07-mobile/MovilTu.dc.html) | LXR-25, LXR-38 |
| [Mobile · Archivos en las conversaciones](07-mobile/MovilArchivos.dc.html) | LXR-25, LXR-31 |
| [Mobile · Menciones con @](07-mobile/MovilMenciones.dc.html) | LXR-25, LXR-31 |
| [Mobile · Contexto y consumo](07-mobile/MovilContexto.dc.html) | LXR-32 |
| [Mobile · Contexto · estados](07-mobile/MovilContextoEstados.dc.html) | LXR-25, LXR-32 |
| [Mobile · Ajustes · cuenta](07-mobile/MovilAjustes.dc.html) | LXR-36 |
| [Mobile · Ajustes · app](07-mobile/MovilAjustes2.dc.html) | LXR-30, LXR-36 |
| [Mobile · Ajustes · conexiones y datos](07-mobile/MovilAjustes3.dc.html) | LXR-36 |
| [Mobile · Ajustes · más](07-mobile/MovilAjustes4.dc.html) | LXR-25, LXR-36 |
| [Mobile · Modelo, esfuerzo y modo](07-mobile/MovilModelo.dc.html) | LXR-30 |
| [Mobile · Movimiento y tacto](07-mobile/MovilMovimiento.dc.html) | LXR-27 |
