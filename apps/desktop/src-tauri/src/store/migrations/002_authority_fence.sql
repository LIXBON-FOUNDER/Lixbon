-- 002_authority_fence: valla de compatibilidad del cambio de autoridad (slice C2b).
--
-- Esta migración NO cambia el esquema de datos. Su único trabajo es subir la
-- versión de la base a 2 para que los binarios que NO conocen el cambio de
-- autoridad (los de C1 y C2a, cuyo máximo es 001) se nieguen a abrirla:
-- `migrate::plan` devuelve `DatabaseNewer`, que en `Core::init` es BLOQUEANTE y
-- ocurre ANTES de que se lea o se reescriba `state.json`.
--
-- NO se aplica al abrir la base. El arranque de C2b abre con las migraciones
-- anteriores a la valla (`store::FENCE_VERSION`), valida el legado y crea una
-- copia verificada `pre-authority`, y SOLO ENTONCES aplica esta migración
-- (`Store::apply_fence`) y publica la intención de promoción. Ver
-- `LIXBON-C2-diseno.md` §11 (estado FENCED).
--
-- Numeración: la 001 reservaba 002..005 a D, E, F y G. Esta migración ocupa la
-- 002; esos slices pasan a 003..006. El comentario de la 001 no se edita (su
-- checksum ya está publicado).

INSERT INTO meta (key, value) VALUES ('authority_fence', 'c2b');
