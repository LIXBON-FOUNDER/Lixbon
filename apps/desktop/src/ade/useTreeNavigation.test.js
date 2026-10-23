import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTreeNavigation } from './useTreeNavigation';

const nodes = [
  { key: 'p', kind: 'project', id: 'p', parentKey: null, expandable: true, expanded: true, firstChildKey: 't' },
  { key: 't', kind: 'task', id: 't', parentKey: 'p', expandable: true, expanded: false, firstChildKey: null },
  { key: 'u', kind: 'task', id: 'u', parentKey: 'p', expandable: false, expanded: false, firstChildKey: null },
];
const key = (k) => ({ key: k, preventDefault: vi.fn() });

describe('useTreeNavigation', () => {
  it('recorre, expande, pliega y sube por {kind, id} sin tocar nada más', () => {
    const focusKey = vi.fn();
    const setExpanded = vi.fn();
    const { result } = renderHook(() => useTreeNavigation({ nodes, focusKey, setExpanded }));
    result.current(key('ArrowDown'), 'p'); expect(focusKey).toHaveBeenLastCalledWith('t');
    result.current(key('End'), 'p'); expect(focusKey).toHaveBeenLastCalledWith('u');
    result.current(key('Home'), 'u'); expect(focusKey).toHaveBeenLastCalledWith('p');
    result.current(key('ArrowRight'), 'p'); expect(focusKey).toHaveBeenLastCalledWith('t');
    result.current(key('ArrowRight'), 't'); expect(setExpanded).toHaveBeenLastCalledWith(nodes[1], true);
    result.current(key('ArrowLeft'), 'p'); expect(setExpanded).toHaveBeenLastCalledWith(nodes[0], false);
    result.current(key('ArrowLeft'), 'u'); expect(focusKey).toHaveBeenLastCalledWith('p');
    const other = key('a');
    result.current(other, 'p');
    expect(other.preventDefault).not.toHaveBeenCalled();
    result.current({ ...key('ArrowDown'), ctrlKey: true }, 'p');
    expect(focusKey).toHaveBeenCalledTimes(5);
  });
});
