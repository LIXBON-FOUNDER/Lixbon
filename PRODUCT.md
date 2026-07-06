# Product

## Register

product

## Users

Desarrolladores y usuarios técnicos de lixbon (plataforma SaaS de LLMs auto-hospedados sobre un clúster GPU distribuido). Dos superficies: la **web** (`apps/web`, chat tipo Claude/GPT en `datacentgbx.online`) y la **app desktop** (`apps/desktop`, IDE ligero Tauri para trabajar con código asistido por los modelos del clúster). El usuario desktop está dentro de una tarea de programación: abre una carpeta, edita archivos y consulta a la IA con contexto de su código. Se autentica con su cuenta de la web (email) o con una API key `lixbon_sk_` creada allí.

## Product Purpose

Dar acceso a los modelos LLM del clúster lixbon con límites por plan (Gratuito/Pro/Advance). La web es el chat generalista; la desktop es el IDE: explorador de archivos, editor con resaltado y chat con streaming que entiende el archivo activo. Éxito = el usuario confía en la herramienta para su flujo diario y la identidad lixbon se percibe idéntica en web y desktop.

## Brand Personality

Nítida, técnica, serena. Minimalismo editorial claro: crema (`#F6F7ED`) y tinta (`#171717`), bordes de 1px en lugar de sombras, formas pill, wordmark Bruno Ace SC, UI en Bricolage Grotesque. Solo tema claro, por decisión de diseño. Idioma de la interfaz: español.

## Anti-references

- El propio desktop legacy: dashboard oscuro violeta con gradientes `rgba(124,58,237,…)`, acentos configurables y estética "terminal hacker". Eso es exactamente lo que se está eliminando.
- SaaS oscuro genérico con glassmorphism, glows y gradient text.
- IDE recargado tipo cockpit (paneles infinitos, docenas de toggles). lixbon desktop es deliberadamente pequeño: explorador + editor + chat.

## Design Principles

1. **Una sola identidad**: los tokens de `apps/web/src/styles/base.css` son la fuente de verdad (espejo documentado en `docs/DISENO_WEB.md`); el desktop los copia, no los reinterpreta.
2. **El borde sustituye a la sombra**: jerarquía por bordes 1px tinta y dos neutros (blanco / crema), no por elevación.
3. **La herramienta desaparece en la tarea**: familiaridad ganada (patrones estándar de IDE — tabs, árbol, Ctrl+S), nada de affordances inventadas.
4. **Estados completos o nada**: cada control con hover/focus/disabled/loading; skeletons de shimmer, no spinners centrados.
5. **Errores del plan en claro**: los límites (cuota, modelo no permitido) se explican en español con la fecha de reinicio, nunca como códigos crudos.

## Accessibility & Inclusion

Contraste alto por diseño (tinta sobre blanco/crema ≥ 4.5:1). Respetar `prefers-reduced-motion` (ya en base.css). Navegación por teclado en el IDE (atajos estándar, focus visible). Sin dependencia del color para estados (texto + icono).
