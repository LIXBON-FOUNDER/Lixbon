import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ModelInfo, ModelMismatchBadge, modelInfo, REPORTED_BY_CODEX_LABEL, MODEL_MISMATCH_TEXT, PLAN_MODE_TEXT, CODEX_CONFIG_MODEL_TEXT } from './ModelInfo';

afterEach(cleanup);

describe('ModelInfo', () => {
  it('muestra pedido y efectivo sin advertencia cuando coinciden', () => {
    render(<ModelInfo task={{ model_requested: 'haiku', model_effective: 'claude-haiku-5-5', model_mismatch: false }} />);
    expect(screen.getByTestId('model-requested').textContent).toBe('haiku');
    expect(screen.getByTestId('model-effective').textContent).toBe('claude-haiku-5-5');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('model_requested null: solo el efectivo y sin advertencia', () => {
    render(<ModelInfo task={{ model_requested: null, model_effective: 'claude-sonnet-4-5', model_mismatch: false }} />);
    expect(screen.queryByTestId('model-requested')).toBeNull();
    expect(screen.getByTestId('model-effective').textContent).toBe('claude-sonnet-4-5');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('model_mismatch true: advertencia visible, sin texto del modo plan si no hay motivo', () => {
    render(<ModelInfo task={{ model_requested: 'opus', model_effective: 'claude-sonnet-4-5', model_mismatch: true }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(MODEL_MISMATCH_TEXT);
    expect(alert.textContent).not.toContain(PLAN_MODE_TEXT);
    expect(alert.textContent).not.toMatch(/esperad/i);
  });

  it('model_mismatch_reason plan_mode: añade el texto del modo plan', () => {
    render(<ModelInfo task={{ model_requested: 'haiku', model_effective: 'claude-sonnet-4-5', model_mismatch: true, model_mismatch_reason: 'plan_mode' }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(MODEL_MISMATCH_TEXT);
    expect(alert.textContent).toContain(PLAN_MODE_TEXT);
  });

  it('la UI no calcula la discrepancia: sin model_mismatch no avisa aunque difieran', () => {
    render(<ModelInfo task={{ model_requested: 'haiku', model_effective: 'claude-sonnet-4-5' }} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('snapshot viejo sin campos de modelo: no pinta nada ni falla', () => {
    const { container } = render(<><ModelInfo task={{ id: 't1', model: 'opus' }} /><ModelMismatchBadge task={{ id: 't1' }} /></>);
    expect(container.textContent).toBe('');
    expect(modelInfo(undefined)).toEqual({ requested: null, effective: null, mismatch: false, fromConfig: false, modelSource: null, sessionMatch: undefined, planMode: false });
  });

  it('model_mismatch distinto de true (p. ej. "true") no cuenta', () => {
    render(<ModelMismatchBadge task={{ model_mismatch: 'true' }} />);
    expect(screen.queryByTestId('model-mismatch-badge')).toBeNull();
  });

  it('badge de la fila con el texto del modo plan en el título', () => {
    render(<ModelMismatchBadge task={{ model_requested: 'haiku', model_mismatch: true, model_mismatch_reason: 'plan_mode' }} />);
    expect(screen.getByTestId('model-mismatch-badge').getAttribute('title')).toContain(PLAN_MODE_TEXT);
  });

  it('Codex sin modelo pedido: "el que defina config.toml", efectivo si se conoce y sin aviso aunque model_mismatch venga true', () => {
    render(<><ModelInfo task={{ agent: 'codex', model_requested: null, model_effective: 'gpt-6-sol', model_mismatch: true }} />
      <ModelMismatchBadge task={{ agent: 'codex', model_requested: null, model_mismatch: true }} /></>);
    expect(screen.getByTestId('model-requested-config').textContent).toBe(CODEX_CONFIG_MODEL_TEXT);
    expect(CODEX_CONFIG_MODEL_TEXT).toBe('el que defina config.toml');
    expect(screen.queryByTestId('model-requested')).toBeNull();
    expect(screen.getByTestId('model-effective').textContent).toBe('gpt-6-sol');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('model-mismatch-badge')).toBeNull();
  });

  it('Codex sin modelo y efectivo desconocido: solo el texto de config.toml, sin nombre inventado', () => {
    const { container } = render(<ModelInfo task={{ agent: 'codex', model_requested: null, model_effective: null }} />);
    expect(container.textContent).toBe(`Pedido: ${CODEX_CONFIG_MODEL_TEXT}`);
  });

  it('model_source session_declared: "Reportado por Codex" en vez de "Respondió"', () => {
    render(<ModelInfo task={{ agent: 'codex', model_requested: 'gpt-6-sol', model_effective: 'gpt-6-sol', model_source: 'session_declared', session_match: 'exact' }} />);
    expect(screen.getByTestId('model-effective-label').textContent).toBe(REPORTED_BY_CODEX_LABEL);
    expect(screen.getByTestId('task-model').textContent).toContain('Reportado por Codex: gpt-6-sol');
    expect(screen.getByTestId('task-model').textContent).not.toContain('Respondió');
  });
  it('otros model_source o ausente: se mantiene "Respondió"', () => {
    for (const model_source of ['stream_json', 'session_id', 'cwd_time', 'unknown', undefined]) {
      render(<ModelInfo task={{ model_requested: 'haiku', model_effective: 'claude-haiku-5-5', model_source }} />);
      expect(screen.getByTestId('model-effective-label').textContent).toBe('Respondió');
      cleanup();
    }
  });
  it('session_match se pasa sin tocar', () => {
    const v = { score: 0.4, why: ['cwd'] };
    expect(modelInfo({ session_match: v }).sessionMatch).toBe(v);
    expect(modelInfo({ session_match: 'cwd_time' }).sessionMatch).toBe('cwd_time');
    expect(modelInfo({ model_source: 'session_declared' }).modelSource).toBe('session_declared');
  });
});
