# LXR-3 y LXR-4 · Iconos compartidos

## Alcance

Los 37 SVG de IdeNuevoArchivos se conservan en shared/icons/file-icons, con renderizadores React y Native. Nombres especiales preceden a pruebas y extensiones; desconocidos usan un documento gris. El editor comparte la extracción de extensión con el resolver. Se usan en árbol, pestañas, buscador, Git, referencias y adjuntos del chat, cambios del agente y comparación/revisión del ADE.

Estados compartidos desde Atención, Hosts y Modo Agente: permiso, pregunta, revisión, campana, red bloqueada, error de código, dispositivos, host que necesita atención y desconectado; hecho, pausa, fallo y trabajando. El ADE real y la vista previa conservan sus estados y textos; las formas los acompañan. La vista previa conserva su aviso de datos simulados.

## Validación

- Desktop: 112 archivos / 1784 pruebas aprobadas; 54 casos nuevos comprueban extensiones, nombres, precedencia y rutas Windows, y la misma función de extensión del editor.
- Vite build aprobado.
- Navegador: archivo package.json abierto, icono npm en árbol y pestaña; resaltado JSON conservado. ADE: anillo r=9, trazo 1,75, animación lineal 0,9 s y cero flags antiguos con «!» genérico. La regla prefers-reduced-motion desactiva el giro.
- Los estados siguen escritos al lado del icono; los SVG decorativos están ocultos al lector de pantalla.

## Pendiente de aceptación

Revisión del otro desarrollador, capturas exportables comparadas con los tableros, matriz completa de gridlines/contraste por estado y prueba del consumidor Native en emulador/teléfono. No se marca Done. La integración móvil se realiza en LXR-25.
