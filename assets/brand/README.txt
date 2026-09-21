LIXBON — ícono 2B (Faceta + destello)
=======================================

ARCHIVOS
  favicon.svg              → favicon escalable (moderno, recomendado)
  favicon-16.png           → pestaña del navegador
  favicon-32.png           → pestaña / bookmarks
  favicon-48.png           → Windows / accesos directos
  apple-touch-icon-180.png → ícono en iPhone/iPad (pantalla de inicio)
  icon-192.png             → Android / PWA
  icon-512.png             → PWA splash / tiendas
  icon-1024.png            → App Store / usos de alta resolución

CÓMO PONERLO EN LA PESTAÑA DE LA PÁGINA
  Copia los archivos a la raíz de tu sitio y pega esto dentro de <head>:

  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180.png">

PWA (manifest.json)
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]

APP MÓVIL
  iOS  → usa icon-1024.png en App Icon (Xcode genera los tamaños).
  Android → usa icon-512.png en el Image Asset Studio de Android Studio.
