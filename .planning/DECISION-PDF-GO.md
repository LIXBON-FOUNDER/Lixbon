# Decisión: extracción de PDF en el CLI Go

Fecha: 2026-10-06 · Issue #14 · Requisito DOC-01 · Estado: aceptada, revisable tras probar más PDFs reales.

## Contexto

El CLI Python extrae el texto de los PDF con `pypdf` (hasta 200 páginas, separador `── página N ──`). El port a Go necesita un adaptador **local, sin helpers externos ni CGO** (ver política en `DECISION-CLI-GO.md`), con licencia compatible y sin subir nada. OCR queda fuera de alcance.

## Candidatos evaluados

Se evaluaron sobre `apps/cli/validation/fixtures/documents_corpus.json` (12 PDF: uno real generado con Edge, texto simple, español, varias páginas, página vacía en medio, tabla, escaneo sin texto, 205 páginas, cifrado, corrupto, no es PDF y fuente incrustada), comparando con `pypdf`.

| Biblioteca | Licencia | CGO | Resultado |
|---|---|---|---|
| `github.com/ledongthuc/pdf` | BSD-3 | no | Lee los casos con texto y reconoce el escaneo sin texto; cifrado y corrupto fallan con error claro. Falla en 1 caso (fuente incrustada con `ToUnicode` roto). Sin dependencias transitivas. |
| `github.com/dslipak/pdf` (fork de la anterior) | BSD-3 | no | **No termina** con el PDF más simple del corpus (se esperó más de 5 minutos). Descartada. |
| `github.com/pdfcpu/pdfcpu` | Apache-2.0 | no | Orientada a manipular PDF (dividir, firmar, optimizar), no a extraer texto con posiciones. No se evaluó en el corpus. |
| MuPDF / poppler | AGPL / GPL | sí / helper | Descartadas sin probar: licencia y CGO o helper externo. |

## Decisión

Usar **`github.com/ledongthuc/pdf`** para leer las páginas y las posiciones de cada carácter, y ensamblar las líneas en `internal/documents/pdf.go`:

- Un salto de Y mayor que 0,4 del cuerpo abre línea nueva; no se duplica el `\n` que la biblioteca ya emite.
- La biblioteca no calcula anchos de glifo (`W = 0`) y solo da dónde empieza cada operación de texto. Entre dos operaciones de la misma línea se inserta un espacio si el hueco supera en un cuerpo lo que ocuparía el texto anterior (0,5 em por carácter). Así las celdas de una tabla no se pegan y las palabras partidas por kerning (`T` + `exto`) no se rompen.
- Cada página se interpreta con `recover`: una página ilegible queda vacía, y si todas lo están el error lo dice (no se confunde con un escaneo).
- La extracción corre en una goroutine con tiempo límite de 30 s: una biblioteca PDF puede colgarse con un archivo hostil. Una prueba aplica 60 mutaciones (truncado, bytes aleatorios, estructura corrupta) al PDF de Edge y exige que ninguna entre en pánico ni tarde más de 5 s.

## Consecuencias

- El texto no es idéntico al de pypdf: los casos simples coinciden byte a byte; la tabla y la fuente incrustada se comparan palabra a palabra; el PDF de Edge se comprueba por frases. pypdf y esta biblioteca tampoco coinciden en tablas (`NombreCantidadPrecio` en pypdf frente a `Nombre Cantidad Precio` aquí).
- **Límite conocido:** un PDF con `ToUnicode` malformado (lo genera PyMuPDF al incrustar una fuente completa) no se lee y devuelve «no se pudo interpretar el texto del PDF». Está en el corpus como `known_gap`. Si aparece en PDF reales de Word, LaTeX o escáneres con OCR, habría que parchear la biblioteca (vendor) o cambiarla.
- No hay pruebas con PDF de Word ni de LaTeX: solo Edge y los sintéticos.
- La dependencia es pequeña (código Go puro, sin dependencias transitivas) y se puede sustituir sin tocar a los llamadores: `documents.PDFText(path) (string, error)`.

## Pendiente

- Probar PDF reales de Word, LaTeX, escáneres con capa de texto y documentos de otras herramientas, y ampliar el corpus.
- Reevaluar si se encuentra una biblioteca pura mantenida que calcule anchos de glifo.
