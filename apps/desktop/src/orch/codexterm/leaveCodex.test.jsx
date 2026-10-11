import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCodexTermStore, useLeaveCodexOnChatChange } from './codexTermStore';

const withActiveTab = () => useCodexTermStore.setState({ tabs: [{ key: 'codex-tab-1', term_id: 't1' }], activeKey: 'codex-tab-1', launcher: false });

describe('useLeaveCodexOnChatChange', () => {
  beforeEach(withActiveTab);

  it('montar de nuevo al volver de otro modo conserva la pestaña de Codex', () => {
    const first = renderHook(({ k }) => useLeaveCodexOnChatChange(k), { initialProps: { k: 'chat-1' } });
    first.unmount();
    renderHook(({ k }) => useLeaveCodexOnChatChange(k), { initialProps: { k: 'chat-1' } });
    expect(useCodexTermStore.getState().activeKey).toBe('codex-tab-1');
  });

  it('elegir otro chat saca a Codex de la vista', () => {
    const { rerender } = renderHook(({ k }) => useLeaveCodexOnChatChange(k), { initialProps: { k: 'chat-1' } });
    rerender({ k: 'chat-2' });
    expect(useCodexTermStore.getState().activeKey).toBeNull();
  });
});
