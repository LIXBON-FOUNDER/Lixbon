// PreviewShell.jsx — la vista previa del ADE dentro del modo Orquestar, con el mismo marco que AdeShell:
// navegador a la izquierda (Collapse + Panel), lienzo con las vistas en el centro e Inspector en el RightDock.
// Los botones de paneles de la barra de título la gobiernan igual que al ADE real.
import { useRef, useState } from 'react';
import { Collapse } from '../../layout/Collapse';
import { Gutter } from '../../layout/Gutter';
import { Panel } from '../../layout/Panel';
import { RightDock } from '../../layout/RightDock';
import { Popover } from '../../components/Popover';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { usePreviewStore } from './previewStore';
import { PreviewSidebar } from './PreviewSidebar';
import { PreviewWorkspace } from './PreviewWorkspace';
import { PreviewAttention } from './PreviewAttention';
import { PreviewCompare } from './PreviewCompare';
import { PreviewProofPack } from './PreviewProofPack';
import { PreviewReview } from './PreviewReview';
import { PreviewMap, PreviewHosts, PreviewUsage } from './PreviewFleet';
import { PreviewInspector } from './PreviewInspector';
import { PreviewOverlays } from './PreviewOverlays';
import { AdeSourceSwitch } from './AdeSourceSwitch';
import { I, Tabs } from './PreviewUi';
import '../AdeShell.css';
import './preview.css';

const VIEWS = [
  { id: 'workspace', label: 'Workspace', icon: 'panel' },
  { id: 'attention', label: 'Attention', icon: 'warn' },
  { id: 'compare', label: 'Comparar', icon: 'split' },
  { id: 'map', label: 'Mapa', icon: 'nodes' },
  { id: 'hosts', label: 'Hosts', icon: 'server' },
  { id: 'usage', label: 'Uso', icon: 'chart' },
];
// Proof Pack y Revisión son subvistas del Workspace: la pestaña activa sigue siendo Workspace.
const TAB_OF = { proof: 'workspace', review: 'workspace' };

function SimulateMenu() {
  const s = usePreviewStore();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const pick = (fn) => () => { setOpen(false); fn(); };
  return (
    <>
      <button ref={ref} type="button" className="lk" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>Simular <I n="down" size={11} /></button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="right">
        <div className="menu" role="menu">
          <div className="menu__label">Controles de la vista previa</div>
          <button type="button" className="menu__item" role="menuitem" onClick={pick(() => s.endTurn(s.sel.attemptId))}><span className="menu__main">Terminar el turno del Intento elegido</span></button>
          <button type="button" className="menu__item" role="menuitem" onClick={pick(() => s.raiseAttention({ kind: 'permission', attemptId: s.sel.attemptId, risk: 'medium', title: 'Instalar una dependencia', command: 'npm install better-sqlite3', riskLabel: 'Modifica las dependencias', reason: 'Almacén local de eventos', scope: 'Solo esta orden, una vez', touches: ['Red: registry.npmjs.org', 'Escribe package.json y package-lock.json'], before: ['Diseñó el almacén de eventos'] }))}><span className="menu__main">Pedir un permiso desde este Intento</span></button>
          <button type="button" className="menu__item" role="menuitem" onClick={pick(s.worstCase)}><span className="menu__main">Datos del peor caso</span></button>
          <div className="menu__sep" />
          <button type="button" className="menu__item" role="menuitem" onClick={pick(s.resetAll)}><span className="menu__main">Reiniciar la simulación</span></button>
        </div>
      </Popover>
    </>
  );
}

function Canvas({ view }) {
  if (view === 'attention') return <PreviewAttention />;
  if (view === 'compare') return <PreviewCompare />;
  if (view === 'proof') return <PreviewProofPack />;
  if (view === 'review') return <PreviewReview />;
  if (view === 'map') return <PreviewMap />;
  if (view === 'hosts') return <PreviewHosts />;
  if (view === 'usage') return <PreviewUsage />;
  return <PreviewWorkspace />;
}

/** `active`: el modo Orquestar es el visible. Oculta, la simulación se conserva tal cual. */
export function PreviewShell({ leftOpen = true, rightOpen = true, drawerOpen, onCloseDrawer, active = true }) {
  const sizes = useWorkbenchStore((st) => st.sizes);
  const view = usePreviewStore((st) => st.view);
  const setView = usePreviewStore((st) => st.setView);
  const attention = usePreviewStore((st) => st.attention.length);
  const tab = TAB_OF[view] || view;
  const views = VIEWS.map((v) => (v.id === 'attention' && attention > 0 ? { ...v, badge: <span className="count">{attention}</span> } : v));
  const sub = view === 'proof' || view === 'review' || view === 'compare';
  return (
    <div className="wb wb--orch ade__layout pv-shell" data-testid="ade-preview">
      <Collapse open={leftOpen} size={Math.max(sizes.side, 280) + 8}>
        <Panel id="ade-nav" className="sidepanel ade__nav">
          <div className="panelhead">
            <span className="panelhead__title">Orquestador</span>
            <span className="panelhead__fill" />
            <AdeSourceSwitch />
          </div>
          <PreviewSidebar />
        </Panel>
        <Gutter sizeKey="side" />
      </Collapse>
      <div className="ade__canvas-stack">
        <div className="ade__context-canvas ade__workspace-canvas">
          <Panel id="ade-workspace" className="wb__grow orch__main ade__workspace pv-canvas">
            <div className="panelhead ade__workspace-head pv-canvas__head">
              <Tabs value={tab} onChange={setView} label="Vista del ADE" options={views} />
              <span className="panelhead__fill" />
              <span className="pv-banner" title="Datos simulados: nada de esta vista lee ni escribe el Core">Vista previa · datos simulados</span>
              <SimulateMenu />
            </div>
            {sub && (
              <div className="pv-back">
                <button type="button" className="lk" onClick={() => setView('workspace')}><I n="left" size={12} />Volver al Workspace</button>
              </div>
            )}
            <div key={view} className="pv-view" role="tabpanel" aria-label={VIEWS.find((v) => v.id === tab)?.label}>
              <Canvas view={view} />
            </div>
          </Panel>
          <RightDock
            id="ade-inspector"
            sizeKey="inspector"
            className="ade__inspector"
            open={rightOpen && view === 'workspace'}
            visible={active}
            keepMountedWhenHidden
            drawerOpen={drawerOpen}
            onCloseDrawer={onCloseDrawer}
          >
            <PreviewInspector />
          </RightDock>
        </div>
      </div>
      {active && <PreviewOverlays />}
    </div>
  );
}
