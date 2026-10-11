import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentChip } from './AgentChip';
import { modelDetail, folderName } from './agentIdentity';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(cleanup);

describe('AgentChip', () => {
  it('muestra proveedor, modelo y esfuerzo', () => {
    render(<AgentChip provider="codex" model="gpt-6-sol" effort="high" testId="c" />);
    const chip = screen.getByTestId('c');
    expect(chip.textContent).toContain('Codex');
    expect(chip.textContent).toContain('gpt-6-sol · high');
    expect(chip.title).toBe('Codex · gpt-6-sol · high');
  });

  it('sin modelo ni esfuerzo solo lleva el nombre; un proveedor desconocido usa su id', () => {
    render(<AgentChip provider="kimi" testId="k" />);
    expect(screen.getByTestId('k').textContent).toBe('Kkimi');
    expect(screen.getByTestId('k').querySelector('.agentchip__detail')).toBeNull();
  });

  it('Claude usa su marca y Codex una inicial', () => {
    const { container, rerender } = render(<AgentChip provider="claude" />);
    expect(container.querySelector('.claudemark')).not.toBeNull();
    rerender(<AgentChip provider="codex" />);
    expect(container.querySelector('.providermark').textContent).toBe('C');
  });
});

describe('agentIdentity', () => {
  it('modelDetail y folderName', () => {
    expect(modelDetail({ model: 'a', effort: '' })).toBe('a');
    expect(modelDetail({})).toBe('');
    expect(folderName('C:\\Users\\x\\proyecto\\')).toBe('proyecto');
    expect(folderName('/home/x/proyecto/')).toBe('proyecto');
    expect(folderName(null)).toBe('');
  });
});
