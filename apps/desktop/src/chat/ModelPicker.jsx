// ModelPicker.jsx — selector de modelo. Carga el catálogo y el mapa rol→modelo.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Popover } from '../components/Popover';
import { IconCheck, IconChevronDown } from '../components/Icons';
import { LogoMark } from '../components/Logo';
import { ProviderMark } from '../orch/agent/ProviderMark';
import { useSessionsStore } from '../store/chatStore';
import { useModelReasoning, reasoningLevels, REASONING_LABELS } from './modelReasoning';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { fetchModelRoles, roleModel, usableModels } from '../lib/modelRoles';

function ModelMark({ model, size = 16 }) {
  const provider = typeof model?.provider === 'string' ? model.provider : typeof model?.owned_by === 'string' ? model.owned_by : null;
  return provider ? <ProviderMark provider={provider.toLowerCase()} size={size} /> : <LogoMark size={size} />;
}

// Se monta cuando el portal ya tiene posición; enfocar antes deja el foco en el chip.
function ModelMenuBody({ menuRef, keyboard, ...props }) {
  useEffect(() => { if (keyboard) menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.focus(); }, [keyboard, menuRef]);
  return <div ref={menuRef} {...props} />;
}

export function ModelPicker() {
  const {
    currentModel, setCurrentModel, availableModels, setAvailableModels,
    setModelRoles, modelRoles, connectionStatus,
  } = useAppStore();
  const selectRef = useRef(null);
  const uid = useId();
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const activeKey = useSessionsStore((state) => state.activeKey);
  const info = availableModels.find((m) => m.id === currentModel);
  const levels = reasoningLevels(info);
  const key = `${activeKey || 'new'}:${currentModel}`;
  const reasoning = useModelReasoning((state) => state.values[key] || 'auto');
  const setReasoning = useModelReasoning((state) => state.setValue);
  const effectiveReasoning = levels.includes(reasoning) ? reasoning : 'auto';
  const close = useCallback(() => { setOpen(false); selectRef.current?.focus(); }, []);
  const onMenuKey = (event) => {
    const items = [...menuRef.current.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
  };

  // /model y la paleta abren el mismo menú con navegación por teclado.
  useEffect(() => {
    const onFocusRequest = () => { if (!selectRef.current?.getClientRects().length) return; setKeyboard(true); setOpen(true); };
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
    const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
    const context = model.context_length || model.context_window;
    return [model.id === roleModel(modelRoles, 'chat') ? 'Recomendado' : null, model.reasoning === 'levels' && /gpt-oss/i.test(model.real || model.id) ? 'Siempre razona' : null, caps.includes('vision') ? 'Ve imágenes' : null, caps.includes('tools') ? 'Código y herramientas' : null, Number.isFinite(context) && context > 0 ? `${Math.round(context / 1024)}k` : null].filter(Boolean).join(' · ');
  };
  return <>
    <button ref={selectRef} className="modelchip" aria-label="Modelo y razonamiento" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${uid}-menu` : undefined} onKeyDown={(event) => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); setKeyboard(true); setOpen(true); } }} onClick={(event) => { setKeyboard(event.detail === 0); setOpen((value) => !value); }} title={`${currentModel} · ${levels.length ? REASONING_LABELS[effectiveReasoning] : 'Auto'}`}>
      <ModelMark model={info} /><span className="modelchip__name">{currentModel}</span><span className="modelchip__level"> · {levels.length ? REASONING_LABELS[effectiveReasoning] : 'Auto'}</span><IconChevronDown size={12} />
    </button>
    <Popover anchorRef={selectRef} open={open} onClose={close} below={false} className={`modelmenu ${keyboard ? 'is-keyboard' : ''}`}>
      <ModelMenuBody id={`${uid}-menu`} menuRef={menuRef} keyboard={keyboard} role="menu" aria-label="Modelo y razonamiento" onKeyDown={onMenuKey}>
        <div className="modelmenu__head" id={`${uid}-models`}>Modelo</div>
        <div className="modelmenu__group" role="group" aria-labelledby={`${uid}-models`}>
        {availableModels.map((model) => <button key={model.id} role="menuitemradio" aria-checked={model.id === currentModel} tabIndex={model.id === currentModel ? 0 : -1} className={`modelmenu__item ${model.id === currentModel ? 'is-active' : ''}`} onClick={() => setCurrentModel(model.id)}>
          <ModelMark model={model} size={16} /><span><span className="modelmenu__name">{model.id}</span>{capabilities(model) && <span className="modelmenu__description">{capabilities(model)}</span>}</span>{model.id === currentModel && <IconCheck size={14} />}
        </button>)}
        </div>
        <div className="modelmenu__reason"><span id={`${uid}-reasoning`}>Razonamiento</span><span>{levels.length ? REASONING_LABELS[effectiveReasoning] : 'No disponible'}</span></div>
        {levels.length > 0 && <div className="modelmenu__levels" role="group" aria-labelledby={`${uid}-reasoning`}>{levels.map((level) => <button key={level} role="menuitemradio" aria-checked={effectiveReasoning === level} tabIndex={-1} className={effectiveReasoning === level ? 'is-active' : ''} onClick={() => setReasoning(key, level)}>{REASONING_LABELS[level]}</button>)}</div>}
        <p className="modelmenu__hint">Piensa antes de responder: mejor en lo difícil, tarda un poco más.</p>
        <button role="menuitem" className="modelmenu__settings" onClick={() => { close(); useAppStore.getState().openModal('settings', 'server'); }}>Más modelos en Ajustes <kbd>Ctrl ,</kbd></button>
      </ModelMenuBody>
    </Popover>
  </>;
}
