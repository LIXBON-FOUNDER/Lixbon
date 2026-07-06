-- plans.sql — Seed de los 3 planes de lixbon (F5).
-- NOTA: init_db() aplica este mismo seed automáticamente al arrancar el gateway
-- (ON CONFLICT DO NOTHING). Este archivo documenta los valores iniciales y sirve
-- para re-sembrar a mano. Los límites REALES viven en la tabla y se ajustan con
-- UPDATE sin tocar código ni redesplegar. -1 = ilimitado.

INSERT INTO plans (id, name, description, price_monthly_cents, currency,
                   messages_per_day, tokens_per_month, max_api_keys,
                   rate_limit_per_min, allowed_models, priority, sort_order,
                   is_active, created_at, updated_at)
VALUES
  ('free', 'Gratuito', 'Para probar el producto', 0, 'USD',
   30, 150000, 1, 10,
   '["llama3.2", "phi", "gemma", "qwen2.5:0.5b", "qwen2.5:1.5b", "qwen2.5:3b"]',
   0, 0, 1, now()::text, now()::text),
  ('pro', 'Pro', 'Para uso habitual', 990, 'USD',
   500, 5000000, 5, 60, NULL, 1, 1, 1, now()::text, now()::text),
  ('advance', 'Advance', 'Power users e integraciones', 2490, 'USD',
   -1, 20000000, 20, 120, NULL, 2, 2, 1, now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

-- Ejemplos de ajuste de límites en caliente:
--   UPDATE plans SET messages_per_day = 50 WHERE id = 'free';
--   UPDATE plans SET allowed_models = NULL WHERE id = 'free';  -- todos los modelos
