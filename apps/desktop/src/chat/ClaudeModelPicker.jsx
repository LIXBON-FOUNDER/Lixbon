import { useEffect, useRef, useState } from 'react';
import { Popover } from '../components/Popover';
import { ClaudeMark } from '../components/Logo';
import { IconCheck, IconChevronDown } from '../components/Icons';
import { useWorkbenchStore } from '../store/workbenchStore';
import { EffortSlider } from './EffortSlider';

const LABELS = {auto: 'Auto', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo'};

export function ClaudeModelPicker({ value, onChange, options, levels, effort, onEffort }) {
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const anchor = useRef(null);
  const menu = useRef(null);
  const selected = options.find((option) => option.value === value);
  const close = () => { setOpen(false); anchor.current?.focus(); };
  useEffect(() => {
    const focus = () => { setKeyboard(true); setOpen(true); };
    window.addEventListener('lixbon:focus-model-picker', focus);
    return () => window.removeEventListener('lixbon:focus-model-picker', focus);
  }, []);
  const navigation = (event) => {
    const items = [...event.currentTarget.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const current = items.indexOf(document.activeElement);
    const index = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (index !== null && event.target.type !== 'range') { event.preventDefault(); items[index]?.focus(); }
  };
  return <>
    <button className="modelchip" ref={anchor} aria-label="Modelo y razonamiento" aria-haspopup="menu" aria-expanded={open} onClick={(event) => { setKeyboard(event.detail === 0); setOpen(!open); }}>
      {selected?.label || value || 'Predeterminado'}{levels.length > 0 && <span className="modelchip__level"> · {LABELS[effort] || 'Auto'}</span>}<IconChevronDown size={12} />
    </button>
    <Popover anchorRef={anchor} open={open} onClose={close} below={false} className={`modelmenu ${keyboard ? 'is-keyboard' : ''}`}>
      <div ref={menu} role="menu" aria-label="Modelo y razonamiento" onKeyDown={navigation}>
        <div className="modelmenu__head">Modelo</div>
        {options.map((option) => <button type="button" key={option.value} className={`modelmenu__item ${option.value === value ? 'is-active' : ''}`} role="menuitemradio" aria-checked={option.value === value} autoFocus={keyboard && option.value === value} onClick={() => onChange(option.value)}><ClaudeMark size={18} /><span className="modelmenu__name">{option.label}</span>{option.value === value && <IconCheck size={14} />}</button>)}
        {levels.length > 0 && <><div className="modelmenu__reason"><span>Razonamiento</span><span>{LABELS[effort] || 'Auto'}</span></div><EffortSlider inline levels={levels} value={effort} onChange={onEffort} /><p className="modelmenu__hint">Piensa antes de responder: mejor en lo difícil, tarda un poco más.</p></>}
        <button type="button" role="menuitem" className="modelmenu__settings" onClick={() => { close(); useWorkbenchStore.getState().openSettings('agent'); }}>Más modelos en Ajustes <kbd>Ctrl ,</kbd></button>
      </div>
    </Popover>
  </>;
}
