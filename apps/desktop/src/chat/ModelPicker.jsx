// ModelPicker.jsx — selector de modelo. Carga el catálogo y el mapa rol→modelo.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from '../components/Popover';
import { IconCheck, IconChevronDown } from '../components/Icons';
import { LogoMark } from '../components/Logo';
import { useSessionsStore } from '../store/chatStore';
import { useModelReasoning, reasoningLevels, REASONING_LABELS } from './modelReasoning';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { fetchModelRoles, roleModel, usableModels } from '../lib/modelRoles';

export function ModelPicker() {
  const {
    currentModel, setCurrentModel, availableModels, setAvailableModels,
    setModelRoles, connectionStatus,
  } = useAppStore();
  const selectRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const activeKey = useSessionsStore((state) => state.activeKey);
  const info = availableModels.find((m) => m.id === currentModel);
  const levels = reasoningLevels(info);
  const key = `${activeKey || 'new'}:${currentModel}`;
  const reasoning = useModelReasoning((state) => state.values[key] || 'auto');
  const setReasoning = useModelReasoning((state) => state.setValue);
  const close = useCallback(() => { setOpen(false); selectRef.current?.focus(); }, []);
  useEffect(() => { if (open && keyboard) menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.focus(); }, [open, keyboard]);
  const onMenuKey = (event) => {
    const items = [...menuRef.current.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
  };

  // El comando /model (menú "/" del composer) dispara este evento: no hay API
  // para abrir un <select> nativo por JS, así que al menos se enfoca y se
  // intenta el click (funciona en Chromium/WebView2 con foco previo).
  useEffect(() => {
    const onFocusRequest = () => { setKeyboard(true); setOpen(true); };
    window.addEventListener('lixbon:focus-model-picker', onFocusRequest);
    return () => window.removeEventListener('lixbon:focus-model-picker', onFocusRequest);
  }, []);

  useEffect(() => {
    if (connectionStatus !== 'connected' || availableModels.length > 0) return;
    let cancelled = false;
    // Un solo sitio carga ambas cosas: /api/model-roles ya incluye el catálogo,
    // así que con gateway nuevo no hay round-trip extra y /v1/models solo se
    // pide como respaldo (gateway antiguo sin el endpoint de roles).
    (async () => {
      const roles = await fetchModelRoles();
      if (cancelled) return;
      let catalogo = roles?.models;
      if (roles) setModelRoles(roles);
      if (!Array.isArray(catalogo) || catalogo.length === 0) {
        const res = await api.get('/v1/models').catch((e) => {
          console.error('[models] Error cargando modelos:', e);
          return null;
        });
        if (cancelled) return;
        catalogo = usableModels(res?.data);
      }
      if (!Array.isArray(catalogo) || catalogo.length === 0) return;
      setAvailableModels(catalogo);
      const ids = catalogo.map((m) => m.id);
      if (!ids.includes(currentModel)) {
        // Preferir el modelo del rol `chat`: una instalación nueva debe arrancar
        // en el modelo de chat configurado, no en el primero que liste Ollama
        // (que puede ser el de visión o el de embeddings).
        const delRol = roleModel(roles, 'chat');
        setCurrentModel(ids.includes(delRol) ? delRol : ids[0]);
      }
    })();
    return () => { cancelled = true; };
  }, [connectionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  if (availableModels.length === 0) {
    return <span className="modelpicker modelpicker--empty">Sin modelos</span>;
  }

  const capabilities = (model) => {
    const caps = model.capabilities || [];
    return [model.reasoning === 'levels' && /gpt-oss/i.test(model.real || model.id) ? 'Siempre razona' : null, caps.includes('vision') ? 'Ve imágenes' : null, caps.includes('tools') ? 'Código y herramientas' : null, model.context_length || model.context_window ? `${Math.round((model.context_length || model.context_window) / 1024)}k` : null].filter(Boolean).join(' · ');
  };
  return <>
    <button ref={selectRef} className="modelchip" aria-label="Modelo y razonamiento" aria-haspopup="menu" aria-expanded={open} onClick={(event) => { setKeyboard(event.detail === 0); setOpen((value) => !value); }}>
      {currentModel}<span className="modelchip__level"> · {levels.length ? REASONING_LABELS[levels.includes(reasoning) ? reasoning : 'auto'] : 'Auto'}</span><IconChevronDown size={12} />
    </button>
    <Popover anchorRef={selectRef} open={open} onClose={close} below={false} className={`modelmenu ${keyboard ? 'is-keyboard' : ''}`}>
      <div ref={menuRef} role="menu" aria-label="Modelo y razonamiento" onKeyDown={onMenuKey}>
        <div className="modelmenu__head">Modelo</div>
        {availableModels.map((model) => <button key={model.id} role="menuitemradio" aria-checked={model.id === currentModel} tabIndex={model.id === currentModel ? 0 : -1} className={`modelmenu__item ${model.id === currentModel ? 'is-active' : ''}`} onClick={() => setCurrentModel(model.id)}>
          <LogoMark size={18} /><span><span className="modelmenu__name">{model.id}</span>{capabilities(model) && <span className="modelmenu__description">{capabilities(model)}</span>}</span>{model.id === currentModel && <IconCheck size={14} />}
        </button>)}
        <div className="modelmenu__reason"><span>Razonamiento</span><span>{levels.length ? REASONING_LABELS[levels.includes(reasoning) ? reasoning : 'auto'] : 'No disponible'}</span></div>
        {levels.length > 0 && <div className="modelmenu__levels">{levels.map((level) => <button key={level} role="menuitemradio" aria-checked={reasoning === level} tabIndex={-1} className={reasoning === level ? 'is-active' : ''} onClick={() => setReasoning(key, level)}>{REASONING_LABELS[level]}</button>)}</div>}
        <p className="modelmenu__hint">Piensa antes de responder: mejor en lo difícil, tarda un poco más.</p>
        <button role="menuitem" className="modelmenu__settings" onClick={() => { close(); useAppStore.getState().openModal('settings', 'server'); }}>Más modelos en Ajustes <kbd>Ctrl ,</kbd></button>
      </div>
    </Popover>
  </>;
}
