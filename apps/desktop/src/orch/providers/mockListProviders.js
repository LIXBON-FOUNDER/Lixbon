// mockListProviders.js — SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1') y pruebas.
// Misma forma que providers.rs (c72ff47). Modelos de Codex: los visibles del fixture real
// testdata/codex-0.162.1-debug-models.json; Claude: alias del --help de 2.1.296.

export const MOCK_CLAUDE = {
  id: 'claude', version: '2.1.296', available: true, disabled_reason: null,
  models: [
    { id: 'fable', label: 'fable', verified: true },
    { id: 'opus', label: 'opus', verified: true },
    { id: 'sonnet', label: 'sonnet', verified: true },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  models_source: 'help',
  sandbox_elevated: false, warnings: [], blocked_profiles: [],
};

export const MOCK_CODEX = {
  id: 'codex', version: '0.162.1', available: true, disabled_reason: null,
  models: [
    ['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6-sol', 'GPT-6-Sol'], ['gpt-6-luna', 'GPT-6-Luna'],
    ['gpt-5.6-sol', 'GPT-5.6-Sol'], ['gpt-5.6-terra', 'GPT-5.6-Terra'], ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ].map(([id, label]) => ({ id, label, verified: true })),
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  models_source: 'debug_models',
  sandbox_elevated: false, warnings: [], blocked_profiles: [],
};

/** Textos exactos de agents.rs (300abea). */
export const ELEVATED = 'el sandbox elevado falla y Codex sale del read-only';
export const WARN_ELEVATED_RW = 'el sandbox elevado de Codex falla en esta máquina: puede editar archivos pero no ejecutar comandos';
/** Lo que añade providers::codex con [windows] sandbox = "elevated". */
export const MOCK_CODEX_ELEVATED = Object.freeze({
  sandbox_elevated: true,
  warnings: [WARN_ELEVATED_RW],
  blocked_profiles: ['explorar', 'proponer'].map((profile) => ({ profile, reason: ELEVATED })),
});

/** `opts.elevated`: Codex con sandbox elevado. `opts.codex`: sobrescribe campos de Codex (p. ej. no instalado) para probar estados. */
export async function mockListProviders(opts = {}) {
  return [{ ...MOCK_CLAUDE }, { ...MOCK_CODEX, ...(opts.elevated ? MOCK_CODEX_ELEVATED : {}), ...(opts.codex || {}) }];
}
