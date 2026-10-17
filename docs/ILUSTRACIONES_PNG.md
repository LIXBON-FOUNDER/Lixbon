# Ilustraciones en PNG: prompts y estilo

Prompts para sustituir por imágenes las ilustraciones SVG de founder.lixbon.com y
lixbon.com. Cada prompt sigue el estilo de las presentaciones de modelos de
anthropic.com: collage analógico de papel recortado, pintura con pincelada
visible, grano de película y trazos sueltos de grafito, adaptado a la paleta de Lixbon.

Los prompts van en inglés porque los generadores de imagen responden mejor así.
Cada uno ya incluye el estilo y se puede pegar tal cual.

## Qué se cambia y qué no

| # | Ilustración | Componente | Dónde se ve | Formato final |
|---|---|---|---|---|
| 1 | Sierra al amanecer (Lámina I) | `PaisajeAmanecer`, founder | Hero de la portada | 16:7 · 2400×1050 |
| 2 | La costa (Lámina II) | `PaisajeCosta`, founder | Sección 01 · Privacidad, y página 404 | 5:4 · 2000×1600 |
| 3 | La sierra de noche, ancha | `PaisajeCrepusculo`, founder | Bloque final «Try it today», a sangre detrás del título | 2:1 · 2880×1440 (y versión móvil 4:5) |
| 4 | La sierra de noche, vertical (Lámina III) | `PaisajeCrepusculo`, lixbon.com | Mitad izquierda del acceso (`LaminaAuth`) | 4:5 · 1600×2000 |

Se quedan en SVG el logo (`Logo.jsx`) y los iconos (`Icons.jsx`). Pesan poco, se
ven nítidos a cualquier tamaño y no cuestan nada de rendimiento.

Lo que pesa de los paisajes actuales no son los bytes, porque cada uno ocupa unos
20–25 KB. Pesa pintarlos: cientos de trazados con degradados, capas con paralaje y
`will-change`, estrellas, luciérnagas y humo animados, y el grano de papel encima.
Un PNG de 2400 px puede ocupar 2–4 MB, así que, para ganar de verdad, el PNG es solo
el original y la web sirve AVIF o WebP (ver «Entrega» al final).

## El estilo

**En palabras:** una lámina hecha a mano para un lanzamiento.
- **Materiales:** papel recortado o rasgado en capas como un diorama, cielos y agua
  pintados al gouache u óleo con la pincelada visible, fibra de papel y grano fino
  de película por todo.
- **Líneas:** pocas, de grafito o carbón, temblorosas y seguras. Solo para olas,
  pájaros, hierba o algún contorno; no se perfila todo.
- **Formas:** simplificadas y algo ingenuas, en planos que se superponen. Sin brillos,
  degradados digitales, efecto 3D ni personas. Mucho aire y calma.
- **Color:** bloques mate y pocos tonos por lámina. La luz se sugiere con la textura
  de la pintura, no con resplandores.

**Paleta común** (sale de los tokens de founder y de los colores de los paisajes actuales):

| Uso | Color |
|---|---|
| Papel crema | `#F2EDE2` · `#F6EEDC` |
| Papel hondo / arena | `#E9E2D3` · `#E6D8BD` |
| Tinta casi negra | `#1F1B14` |
| Oliva / oliva oscuro | `#B4C64E` · `#5E6B1E` · `#3F4722` |
| Lima de acento (los `em` de los títulos) | `#D7E38A` |
| Terracota (tejados, faro) | `#C06A4A` · `#B8664A` |
| Sol / ámbar | `#EFBA78` · `#E3A366` |
| Mar salvia | `#A9B4AB` · `#8FA39A` |
| Noche índigo / violeta de horizonte | `#1B1F2A` · `#34344A` · `#6E5563` |

**Bloque de estilo** (ya va dentro de cada prompt; aquí suelto por si quieres reutilizarlo):

```
Mixed-media editorial illustration, hand-made like a printed plate for a product launch:
layered cut-paper and torn-paper shapes stacked in depth like a quiet paper diorama, skies and
water painted in gouache and oil with clearly visible brush strokes and dry-brush edges, coarse
paper fibre, fine film grain and subtle risograph-like noise over the whole image. Simplified,
slightly naive shapes with irregular hand-cut edges. Only a few loose hand-drawn marks in graphite
or charcoal (waves, birds, grass blades, a contour here and there), with an uneven but confident
line — not outlining everything. Matte flat colour blocks from a limited palette, light suggested
by painted texture instead of glow. Calm, contemplative, generous negative space.
No text, no letters, no logos, no people.
```

**Prompt negativo** (para Midjourney `--no`, Stable Diffusion, Flux o Leonardo):

```
photorealistic, photo, 3D render, CGI, octane, vector clip art, smooth digital gradient, glossy,
plastic, neon, lens flare, bloom, glow, HDR, anime, cartoon, thick black outlines everywhere,
text, letters, watermark, signature, frame, border, people, faces, logo, cluttered, oversaturated
```

---

## 1 · Sierra al amanecer (hero de founder)

- **Archivo:** `founder/public/laminas/sierra-amanecer.png`
- **Formato:** 16:7, 2400×1050. En la web se muestra a 1200:525 y en móvil a 300 px
  de alto, recortado por el centro.
- **Zona segura:** lo importante (sol, pueblo y camino) dentro del 60 % central. Los
  bordes izquierdo y derecho pueden perderse en móvil.
- **Pie de foto en la web:** «— Sierra at dawn · Plate I».

```
Mixed-media editorial illustration of a mountain valley at dawn, wide panoramic landscape plate,
16:7. A large low sun, warm apricot #EFBA78 painted as a thick gouache disc with a soft painted
halo, sits just right of centre at the height of the far ridges, with a few faint brushed rays
fanning upward. Pale sky painted in horizontal strokes from cool grey-cream #CFCBBC at the top to
warm peach #F8E8CC near the horizon; three or four small cut-paper clouds in cream #FBF4E6 with
sand shadows. Two distant mountain ridges in dusty sage with small snow caps torn from white
paper, one on the left third and one on the right. A band of morning mist (dry-brushed cream)
lies between the far ridges and rolling hills. Hills stacked in depth like paper layers: pale sage
#BDBE9A, then olive #9CA473, then deep olive #6E7A3C, then dark olive #434C23 in the foreground.
On a middle hill slightly left of centre, a tiny whitewashed village of four houses with terracotta
#B46A4C roofs and a small bell tower. A winding cream-coloured river path runs from the bottom
centre-right up toward the village, with a few graphite strokes for ripples. Small pines in loose
groups on the middle hills; dark cypress trees standing tall at the left and right edges; round
olive trees dotted on the slopes. A small flock of birds drawn in graphite near the centre of the
sky. In the bottom foreground, a wildflower meadow with tiny dabs of mustard #E8C77A, coral
#D98B6A, cream and lilac #C9A9C9. Layered cut-paper and torn-paper shapes, visible brush strokes,
dry-brush edges, coarse paper fibre, fine film grain, subtle risograph noise. Simplified, slightly
naive shapes with irregular hand-cut edges, only a few loose graphite marks. Matte limited palette,
light suggested by painted texture instead of glow. Calm, contemplative, generous negative space.
No text, no letters, no logos, no people.
```

## 2 · La costa (sección Privacidad y página 404)

- **Archivo:** `founder/public/laminas/costa.png`
- **Formato:** 5:4, 2000×1600, con la lámina en vertical (`lamina--retrato`).
- **Zona segura:** el faro y el velero no deben quedar a menos del 10 % del borde.
- **Pie de foto:** «— The coast, with no middlemen · Plate II». La 404 usa la misma imagen.

```
Mixed-media editorial illustration of a quiet Mediterranean coast in the early evening, portrait
plate, 5:4. Warm cream-peach sky painted in soft horizontal gouache strokes, a low coral-orange
sun #EDA774 resting on the horizon on the left third with a thin painted halo, two or three small
cut-paper clouds in cream with sand shadows, a few graphite birds high in the middle. Far left, a
low grey-sage headland torn from paper on the horizon. A calm sea in sage-teal #A9B4AB fills the
lower half, painted with visible horizontal brush strokes, with a golden path of short cream and
apricot dashes under the sun and pale horizontal wave marks. In the middle of the sea, a tiny white
sailboat with a dark hull. On the right, a tall sandy ochre cliff made of layered torn paper, its
top covered with olive green #6F7A3E scrub, a few graphite strata lines on its face. On the
clifftop, a slim lighthouse in cream with two terracotta #C06A4A bands and a dark lantern room
with a warm yellow light and a very faint beam sweeping left, plus four small white houses with
terracotta roofs. Bottom-left foreground: dark charcoal rocks #26291B with two cream seagulls drawn
in a few strokes. Layered cut-paper and torn-paper shapes, visible brush strokes, dry-brush edges,
coarse paper fibre, fine film grain, subtle risograph noise. Simplified, slightly naive shapes with
irregular hand-cut edges, only a few loose graphite marks. Matte limited palette, light suggested
by painted texture instead of glow. Calm, contemplative, generous negative space.
No text, no letters, no logos, no people.
```

## 3 · La sierra de noche, ancha (bloque final de founder)

- **Archivo:** `founder/public/laminas/sierra-noche.png`, más
  `sierra-noche-movil.png` (4:5, 1080×1350) para pantallas de menos de 700 px.
- **Formato:** 2:1, 2880×1440. Va a sangre detrás de un título enorme en crema
  (`#F6EEDC`), centrado, con el énfasis en lima `#D7E38A`.
- **Zona segura:** el tercio central horizontal (cielo medio y montañas) debe quedar
  tranquilo y oscuro, sin estrellas grandes ni la luna, para que el texto se lea. La
  luna va arriba a la derecha y la cabaña abajo a la izquierda.

```
Mixed-media editorial illustration of a mountain lake at night, wide panoramic plate, 2:1. Night
sky painted in broad oil and gouache strokes from deep indigo #1B1F2A at the top through dusky
violet #34344A and mauve #6E5563 to a thin warm amber band #E3A366 just above the mountains. A
faint diagonal milky way dry-brushed in cream, many small stars as tiny cream paint dots and a few
small hand-drawn four-point sparkles, one short shooting star drawn as a graphite streak in the
upper left. A crescent moon cut from cream paper #F6EEDC with a soft painted halo in the upper
right. The middle of the composition stays calm and dark, with nothing but sky texture and the
mountain line, leaving clear room for a large centred headline. Behind, misty mauve mountains torn
from paper with a dry-brushed amber haze; in front, a long ridge of dark pine forest silhouettes in
near-black #222226. A still lake fills the lower third, painted dark at the bottom and warm amber
#D69A63 under the horizon, with short horizontal cream and apricot reflection strokes in the centre
and under the moon. Left foreground: a dark hill #1C1D1A with a small cabin silhouette, two warm
lit windows #F5C27A, a thin graphite curl of chimney smoke, and a few yellow fireflies as tiny
dots. Right foreground: a dark bank with a few tall reeds drawn in charcoal. Layered cut-paper and
torn-paper shapes, visible brush strokes, dry-brush edges, coarse paper fibre, fine film grain,
subtle risograph noise. Simplified, slightly naive shapes with irregular hand-cut edges, only a
few loose graphite marks. Matte limited palette, light suggested by painted texture instead of
glow. Calm, contemplative, generous negative space. No text, no letters, no logos, no people.
```

**Versión móvil (4:5):** el mismo prompt cambiando `wide panoramic plate, 2:1` por
`portrait plate, 4:5` y la frase de la composición por: `The moon sits high in the upper
right, the cabin in the lower left; the middle band stays calm and dark for a centred headline.`

## 4 · La sierra de noche, vertical (acceso de lixbon.com)

- **Archivo:** `apps/web/public/laminas/sierra-noche-acceso.png`
- **Formato:** 4:5, 1600×2000. Ocupa la mitad izquierda de la pantalla a toda altura
  y desaparece por debajo de 900 px.
- **Zona segura:** el 30 % inferior izquierdo lleva el pie «The sierra at night ·
  Plate III» y la frase «What you write stays *with you*.» en crema y lima, así que
  esa zona va oscura y lisa (lago o tierra en sombra), sin cabaña ni luciérnagas encima.

```
Mixed-media editorial illustration of a mountain lake at night, tall portrait plate, 4:5. The upper
half is a night sky painted in broad oil and gouache strokes from deep indigo #1B1F2A at the top
through dusky violet #34344A and mauve #6E5563 to a thin warm amber band #E3A366 above the
mountains, with a faint diagonal dry-brushed milky way, many small cream star dots and a few tiny
hand-drawn four-point sparkles. A crescent moon cut from cream paper #F6EEDC with a soft painted
halo sits in the upper right. At about sixty percent of the height, misty mauve mountains torn from
paper and a ridge of dark pine forest silhouettes in near-black #222226. Below, a still lake
painted warm amber #D69A63 under the horizon and fading to almost black at the bottom, with short
horizontal cream reflection strokes under the moon. A small dark hill on the right side with a
cabin silhouette, two warm lit windows #F5C27A, a thin graphite curl of chimney smoke and a few
yellow firefly dots. The lower-left third of the image stays dark, smooth and empty (deep lake
water and shadowed ground), leaving room for a caption and a headline. Layered cut-paper and
torn-paper shapes, visible brush strokes, dry-brush edges, coarse paper fibre, fine film grain,
subtle risograph noise. Simplified, slightly naive shapes with irregular hand-cut edges, only a
few loose graphite marks. Matte limited palette, light suggested by painted texture instead of
glow. Calm, contemplative, generous negative space. No text, no letters, no logos, no people.
```

---

## Fondos de los videos de producto (founder)

Tres láminas nuevas para el fondo de los videos de las tarjetas de productos (IDE,
App móvil y Visuals). Cada video lleva la suya, distinta de las láminas de la web.
No se publican como imagen: quedan dentro del video.

- **Archivos:** `img-lixbon/fondo-ide.png`, `img-lixbon/fondo-movil.png` y
  `img-lixbon/fondo-visuals.png`.
- **Formato:** 16:9, 2400×1350 o más.
- **Zona segura:** la app tapa el centro (la ventana del IDE, el teléfono, el editor
  de Visuals) y la cámara se acerca mucho. Por eso el tercio central va tranquilo, sin
  nada importante, y lo que da carácter va en los tercios izquierdo y derecho y en la
  franja de arriba.
- **Contraste:** tonos medios y poco contraste, para que la app se lea encima.

### 5 · Valle del río al final de la tarde (IDE)

La ventana del IDE es oscura, así que el fondo va cálido y algo profundo.

```
Mixed-media editorial illustration of a quiet river valley in the late afternoon, wide landscape
plate, 16:9. Low warm sun just out of frame on the right, the light suggested by long apricot
#E3A366 brush strokes across the upper sky, which fades from dusty ochre #D9B48A at the horizon
to muted slate blue #7E8C93 at the top, with two or three long cut-paper clouds in cream and sand.
In the left third, an old stone bridge with two round arches torn from warm grey paper crosses the
river, and a small stone mill with a terracotta #B8664A roof stands on the bank beside it. In the
right third, a row of tall poplars in olive #6E7A3C and a steep wooded hillside in deep olive
#3F4722. The river runs low and calm across the whole bottom of the plate in sage-teal #8FA39A,
painted with short horizontal strokes and a few cream glints, with reeds drawn in charcoal at the
edges. The centre of the composition stays calm and simple (soft hills in muted olive and the
distant valley in hazy sage #A9B4AB), with no buildings or strong shapes, because an app window
will cover it. Layered cut-paper and torn-paper shapes, visible brush strokes, dry-brush edges,
coarse paper fibre, fine film grain, subtle risograph noise. Simplified, slightly naive shapes
with irregular hand-cut edges, only a few loose graphite marks. Matte limited palette, mid tones
and low contrast, light suggested by painted texture instead of glow. Calm, contemplative,
generous negative space. No text, no letters, no logos, no people.
```

### 6 · Campos de lavanda a la hora dorada (App móvil)

El teléfono es oscuro y ocupa el centro. Los surcos de lavanda dan ritmo a los lados.

```
Mixed-media editorial illustration of lavender fields in the golden hour, wide landscape plate,
16:9. A warm sky painted in soft horizontal gouache strokes from pale peach #F8E8CC at the horizon
to warm cream #F2EDE2 and a faint lilac grey at the top, a low amber sun #EFBA78 as a thick painted
disc in the upper left with a soft painted halo, a few small cut-paper clouds. Rows of lavender in
muted lilac #9C88A8 and dusty violet #6E5563 run in converging stripes toward the horizon, cut from
paper with irregular edges, the furrows between them in warm ochre earth #C9A46A. In the right
third, a small stone farmhouse in sand #E6D8BD with a terracotta #C06A4A roof and two tall dark
cypress trees. In the left third, a single round olive tree and a low dry-stone wall. Distant
hills in pale sage #BDBE9A along the horizon. A few graphite birds high on the right. The centre
of the composition stays calm and even (only lavender rows and sky), with no buildings or trees,
because a phone will cover it. Layered cut-paper and torn-paper shapes, visible brush strokes,
dry-brush edges, coarse paper fibre, fine film grain, subtle risograph noise. Simplified, slightly
naive shapes with irregular hand-cut edges, only a few loose graphite marks. Matte limited palette,
mid tones and low contrast, light suggested by painted texture instead of glow. Calm,
contemplative, generous negative space. No text, no letters, no logos, no people.
```

### 7 · Trigales y molino por la mañana (Visuals)

El editor de Visuals es claro y el ejemplo es una panadería: trigo, molino y amapolas.

```
Mixed-media editorial illustration of wheat fields on a fresh summer morning, wide landscape plate,
16:9. A clear morning sky painted in soft horizontal gouache strokes from pale cream #FBF4E6 at the
horizon to a soft cool blue-grey #B9C4C4 at the top, a few cut-paper clouds in cream with sand
shadows. Gently rolling hills of ripe wheat in golden ochre #E8C77A and mustard #D9AE5A, with
lighter sand #E6D8BD stripes where the fields are cut, and a few graphite strokes for the wheat
ears in the foreground. In the right third, a white windmill with a terracotta #B8664A cap and four
sails standing on a small hill. In the left third, a dirt path curving away and a group of round
olive #6E7A3C trees. Small dabs of poppy coral #D98B6A and cream wildflowers along the bottom edge.
Distant hills in pale sage #BDBE9A. The centre of the composition stays calm and even (only fields
and sky), with no buildings or trees, because a light app window will cover it. Layered cut-paper
and torn-paper shapes, visible brush strokes, dry-brush edges, coarse paper fibre, fine film grain,
subtle risograph noise. Simplified, slightly naive shapes with irregular hand-cut edges, only a few
loose graphite marks. Matte limited palette, mid tones and low contrast, light suggested by painted
texture instead of glow. Calm, contemplative, generous negative space. No text, no letters, no
logos, no people.
```

---

## Acceso de la app móvil (login y registro)

Dos láminas para la parte de arriba de las pantallas de acceso de `apps/mobile`. Cada
vista lleva la suya: entrar es volver a casa y crear la cuenta es salir de viaje.

- **Archivos:** `img-lixbon/acceso-login.png` y `img-lixbon/acceso-registro.png`.
- **Formato:** 3:4 en vertical, 1500×2000 o más. La app la recorta por el centro para
  una franja de arriba: unos 45 % de la pantalla en el login y 30 % en el registro.
- **Zona segura:** lo importante (la casa, el barco, el sol) en el 55 % de arriba y
  centrado. El 40 % de abajo va tranquilo y liso (agua, campo en sombra), porque se
  funde con el fondo de la app y el titular va encima. Los bordes izquierdo y derecho
  pueden perderse.
- **Temas:** la misma imagen sirve en oscuro y en claro; la app pone encima un
  degradado al color del fondo.

### 8 · Volver a casa a la hora azul (login, «Bienvenido de nuevo»)

```
Mixed-media editorial illustration of a small house on a hill at blue hour, tall portrait plate,
3:4. The sky fills the upper half, painted in broad oil and gouache strokes from deep blue-grey
#2B3140 at the top through dusky violet #4A4560 to a thin warm apricot band #E3A366 low on the
horizon, with a few small cream star dots and one bright evening star. In the centre, at about
forty percent of the height, a gentle hill cut from dark olive paper #3F4722 with a small
whitewashed house with a terracotta #B8664A roof and two warm lit windows #F5C27A, a thin graphite
curl of chimney smoke, and one round olive tree beside it. A winding cream path climbs from the
bottom centre up to the door, drawn with a few graphite strokes. Behind, two soft ridges in misty
mauve #6E5563 torn from paper. The lower forty percent of the plate is calm and dark: a meadow in
shadow, deep olive #2B3018 fading to almost black #1B1A17 at the bottom edge, with only a few faint
grass blades in charcoal and two or three tiny yellow fireflies, leaving room for a headline.
Layered cut-paper and torn-paper shapes, visible brush strokes, dry-brush edges, coarse paper
fibre, fine film grain, subtle risograph noise. Simplified, slightly naive shapes with irregular
hand-cut edges, only a few loose graphite marks. Matte limited palette, light suggested by painted
texture instead of glow. Calm, contemplative, generous negative space. No text, no letters, no
logos, no people.
```

### 9 · Zarpar al amanecer (registro, «Crea tu cuenta»)

```
Mixed-media editorial illustration of a quiet harbour at sunrise with a small sailboat setting
out, tall portrait plate, 3:4. The sky fills the upper half, painted in soft horizontal gouache
strokes from pale cream #FBF4E6 at the top to warm peach #F8E8CC and apricot #EFBA78 near the
horizon, with a low sun as a thick painted disc #EDA774 just above the sea in the centre and two
or three small cut-paper clouds in cream with sand shadows, a few graphite gulls. At about forty
percent of the height, the horizon: a calm sea in sage-teal #A9B4AB with a golden path of short
cream and apricot dashes under the sun, and a small white sailboat with a dark hull and a cream
sail heading out toward the sun, slightly left of centre. On the left edge, the end of a stone
harbour wall in sand #E6D8BD with a small lantern post; on the right edge, a low headland torn from
grey-sage paper with two tiny white houses with terracotta #C06A4A roofs. The lower forty percent
is calm open water, darkening gradually from sage-teal to deep slate #3A4A4A at the bottom edge,
with only a few pale horizontal wave marks in graphite, leaving room for a headline. Layered
cut-paper and torn-paper shapes, visible brush strokes, dry-brush edges, coarse paper fibre, fine
film grain, subtle risograph noise. Simplified, slightly naive shapes with irregular hand-cut
edges, only a few loose graphite marks. Matte limited palette, light suggested by painted texture
instead of glow. Calm, contemplative, generous negative space. No text, no letters, no logos,
no people.
```

En Midjourney usa `--ar 3:4`.

---

## Para que las cuatro parezcan una serie

1. Genera primero la 3 (noche ancha). Es la más difícil y fija el grano, la pincelada y el papel.
2. Usa esa imagen como referencia de estilo para las otras tres: `--sref` en Midjourney,
   «image prompt» o «style reference» en Leonardo, Ideogram y Flux, o adjúntala en
   ChatGPT y pide «same style as the reference».
3. En Midjourney añade `--ar 16:7` / `--ar 5:4` / `--ar 2:1` / `--ar 4:5` (y `--ar 16:9` en los fondos de video), `--style raw`
   y `--stylize 150` a `250`. En el resto, pide la relación de aspecto en el propio prompt,
   como ya va escrito.
4. Revisa cada lámina con su texto encima antes de darla por buena. En la 3 y la 4, el
   crema y el lima tienen que leerse sin sombras añadidas.

## Entrega en la web

- Guarda el PNG como original y publica **AVIF** (calidad 50–60) más **WebP** (calidad
  75–80) de respaldo, a dos anchos: 1200 y 2400 px (en la 4: 800 y 1600).
- Sírvelas con `<picture>`, `width` y `height` fijos (sin saltos de diseño) y `decoding="async"`.
  El hero lleva `fetchpriority="high"` y el resto `loading="lazy"`.
- Objetivo de peso: menos de 250 KB el hero en AVIF y menos de 180 KB las demás.
- Con un PNG se pierden el paralaje por capas y las animaciones (estrellas, estrella fugaz,
  luciérnagas, humo). Si quieres conservar un poco de vida, basta con 4–6 puntos de luz
  absolutos con una animación de opacidad sobre la imagen. Cuestan mucho menos que el SVG entero.
