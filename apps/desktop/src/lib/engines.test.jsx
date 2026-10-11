import { describe, it, expect, vi } from 'vitest';
import { ENGINES, engineOf, EXTRA_CHAT_ENGINES, TERMINAL_ENGINE_IDS, ENGINE_IDS } from './engines';
import { CHAT_ENGINES, TERMINAL_ENGINES, newAgentEntries } from '../orch/providers/newAgentEntries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

describe('registro de motores', () => {
  it('cada motor trae lo que la interfaz necesita para pintarlo', () => {
    for (const id of ENGINE_IDS) {
      const e = ENGINES[id];
      expect([e.id, typeof e.label, typeof e.short, typeof e.Mark]).toEqual([id, 'string', 'string', 'function']);
    }
    expect(ENGINES.claude.dock).toBe(true);
    expect(ENGINES.lixbon.dock).toBe(false);
  });

  it('un motor ausente o desconocido es el agente de Lixbon', () => {
    expect(engineOf(undefined).id).toBe('lixbon');
    expect(engineOf('gemini-chat').id).toBe('lixbon');
    expect(engineOf('claude').id).toBe('claude');
  });

  it('«+ Nuevo» sale del registro: Claude abre chat y Codex terminal', () => {
    expect(EXTRA_CHAT_ENGINES).toEqual(['claude']);
    expect(TERMINAL_ENGINE_IDS).toEqual(['codex']);
    expect(CHAT_ENGINES).toBe(EXTRA_CHAT_ENGINES);
    expect(TERMINAL_ENGINES).toBe(TERMINAL_ENGINE_IDS);
    const kinds = Object.fromEntries(newAgentEntries([{ id: 'claude', available: true }, { id: 'codex', available: true }]).map((e) => [e.id, e.kind]));
    expect(kinds).toEqual({ claude: 'chat', codex: 'terminal' });
  });
});
