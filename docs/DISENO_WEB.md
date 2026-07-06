# lixbon — Especificación de diseño de la web (datacentgbx.online)

> Fuente: mockups del 2026-07-04 (login, registro, chat con y sin sesión).
> Este documento es la referencia de implementación para `apps/web`.

## 1. Design tokens

### Tipografía

| Uso | Fuente | Peso/Tamaño |
|---|---|---|
| Wordmark "lixbon" | **Bruno Ace SC** | — |
| Títulos | **Bricolage Grotesque** | Medium |
| Nombres de secciones (sidebar) | Bricolage Grotesque | Regular 12 |
| Títulos en respuestas de la IA | Bricolage Grotesque | Semibold |
| Subtítulos | Bricolage Grotesque | Regular 12 |

Ambas fuentes están en Google Fonts (self-host en `apps/web/public/fonts/` — la CSP/offline y el rendimiento lo agradecen).

### Colores

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#FFFFFF` | Fondo principal |
| `--bg-secondary` | `#F6F7ED` | Crema: fondo de auth, caja de input del chat, footer de perfil en sidebar |
| `--ink` | `#171717` | Botones principales, avatar sin foto, texto principal |
| `--border` | `#171717` 1px | Bordes de tarjetas, sidebar, inputs |
| Acento plan | verde-amarillo (ver mockup "Plan Advance") | Etiqueta del plan del usuario |

### Iconos
Librería: **7000 FREE UI ICONS (Community)** — trazo fino, consistente con el diseño.
Exportar a SVG los necesarios en `apps/web/src/assets/icons/`.

### Formas
- Botones y campos: **pill / full-rounded** (border-radius alto en todo).
- Botón primario: fondo `#171717`, texto blanco, pill.
- Botón secundario: fondo blanco, borde 1px `#171717`, pill.
- Inputs de auth: blancos, borde fino, **label flotante sobre el borde** (estilo outlined de Material).

## 2. Pantallas

### 2.1 Chat (usuario con sesión) — pantalla principal
- **Sidebar izquierda** (borde 1px, fondo blanco):
  - Header: logo lixbon + icono buscar + icono colapsar sidebar.
  - Navegación: `Nueva conversación` (icono +), `Conversaciones`, `Aplicaciones`, `Más` (…).
  - Sección **Historial** (colapsable, chevron) con lista de conversaciones (título truncado con "…").
  - **Footer de perfil** (fondo crema): avatar circular `#171717` con inicial en blanco, nombre completo, etiqueta del plan en acento ("Plan Advance"), icono de ajustes.
- **Área principal**:
  - Título de la conversación arriba a la izquierda.
  - Botón **"Compartir"** (pill negra, icono share) arriba a la derecha → compartir conversación (feature nueva).
  - Respuestas de la IA con jerarquía: título Semibold, subtítulos, listas numeradas con círculos.
  - Botón **"más ↓"** (pill negra flotante) para saltar al final del stream.
  - **Caja de input** abajo: fondo crema, redondeada, iconos izquierda (adjuntar/link, web), derecha (micrófono, botón enviar = círculo negro con logo).

### 2.2 Chat (visitante sin sesión)
- Mismo layout con sidebar (historial vacío).
- Top right: `Inicia Sesion` (pill outline) + `Registrate` (pill negra).
- Centro: título **"¿Qué investigaremos hoy?"** con la caja de input debajo.
- Footer de perfil: "Iniciar sesion / Plan Gratuito".

### 2.3 Login
- Fondo crema `#F6F7ED`, logo lixbon centrado (Bruno Ace SC).
- **Toggle segmentado** pill: `Iniciar Sesion` / `Registrarse` (activo = fondo negro, texto blanco).
- Campos: **Correo Electronico**, **Contraseña** (outlined, label en el borde).
- CTA pill negra "Iniciar Sesion".
- Link "¿Olvidaste tú contraseña?".
- Divisor "O inicia sesion con" + botones sociales: **Google** (blanco) y **Apple** (negro).

### 2.4 Registro
- Igual que login con campos: **Nombre**, **Apellido** (en fila), **Correo Electronico**, **Contraseña**, **Confirmar Contraseña**.
- CTA "Crear Cuenta" + sociales.

## 3. Implicaciones de backend (se incorporan a F3/F4)

| Requisito del diseño | Impacto |
|---|---|
| Login por **email** (no username) | F3: `users.email` como identificador de login |
| **Nombre y Apellido** en registro | F3: columnas `first_name`, `last_name`; avatar = inicial del nombre |
| Recuperar contraseña | F3: flujo de reset por email (ya estaba en plan) |
| OAuth **Google/Apple** | Decisión de producto pendiente (Apple exige Developer Program de pago) |
| Chat visible **sin sesión** | Decisión de producto pendiente: qué pasa al enviar sin cuenta |
| Etiqueta del plan en el perfil | F5: viene de `plans` |
| **Compartir conversación** | Feature nueva: link público de solo lectura (F4 o posterior) |
| Buscar conversaciones | F4: search en historial |
| "Aplicaciones" en sidebar | Sección futura (placeholder por ahora) |
| Micrófono en input | Futuro (Web Speech API); ocultar o deshabilitar en v1 |
