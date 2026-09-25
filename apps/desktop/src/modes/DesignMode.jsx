// DesignMode.jsx — vista previa del proyecto en marcha con emulación de
// dispositivos (móvil, tablet, escritorio) y el agente al lado para iterar.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { detectRoutes } from '../lib/routes';
import { usePreviewBridge, Layers, InspectorPanel } from './DesignInspector';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { AgentPanel } from '../chat/AgentPanel';
import { Segmented } from '../components/Segmented';
import { openExternal } from '../lib/tauri';
import { IconRotate, IconRefresh, IconExternal, IconFileCode, IconCursor } from '../components/Icons';

export const DEVICES = [
  { id: 'iphone-se', group: 'mobile', name: 'iPhone SE', w: 375, h: 667 },
  { id: 'iphone-15', group: 'mobile', name: 'iPhone 15', w: 393, h: 852 },
  { id: 'pixel-8', group: 'mobile', name: 'Pixel 8', w: 412, h: 915 },
  { id: 'ipad-mini', group: 'tablet', name: 'iPad mini', w: 768, h: 1024 },
  { id: 'ipad-air', group: 'tablet', name: 'iPad Air', w: 820, h: 1180 },
  { id: 'laptop', group: 'desktop', name: 'Portátil', w: 1280, h: 800 },
  { id: 'desktop', group: 'desktop', name: 'Escritorio', w: 1440, h: 900 },
];

const GROUP_DEFAULT = { mobile: 'iphone-15', tablet: 'ipad-air', desktop: 'laptop' };
const BREAKPOINTS = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];
const ZOOMS = ['fit', 0.5, 0.75, 1];
const GAP = 6;

const breakpointOf = (w) => BREAKPOINTS.filter(([, px]) => w >= px).map(([n]) => n).pop() || 'base';

function normalizeUrl(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

function Viewport({ url, src, frameRef, device, landscape, zoom, reloadKey }) {
  const stageRef = useRef(null);
  const [fitScale, setFitScale] = useState(1);
  const w = landscape ? device.h : device.w;
  const h = landscape ? device.w : device.h;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const compute = () => {
      const pad = 48;
      setFitScale(Math.min(1, (el.clientWidth - pad) / w, (el.clientHeight - pad) / h));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);

  const scale = zoom === 'fit' ? fitScale : zoom;

  return (
    <div className="stage" ref={stageRef}>
      <div className="viewport" style={{ width: w * scale, height: h * scale }}>
        {url ? (
          <iframe
            ref={frameRef}
            key={reloadKey}
            title="Vista previa"
            src={src || url}
            className="viewport__frame"
            style={{ width: w, height: h, transform: `scale(${scale})` }}
          />
        ) : (
          <div className="viewport__empty">Escribe la URL de tu servidor de desarrollo</div>
        )}
      </div>
    </div>
  );
}

function Screens({ url, onGo }) {
  const root = useAppStore((s) => s.workspaceRoot);
  const [routes, setRoutes] = useState(null);
  useEffect(() => {
    let alive = true;
    setRoutes(null);
    detectRoutes().then((r) => { if (alive) setRoutes(r); });
    return () => { alive = false; };
  }, [root]);
  let current = '/';
  try { current = new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { /* URL a medio escribir */ }
  const openFile = (r) => {
    useWorkbenchStore.getState().setMode('editor');
    if (r.line) useFileViewStore.getState().revealLine(r.file, r.line);
    else useFileViewStore.getState().open(r.file);
  };
  return (
    <>
      <div className="fieldlabel">Pantallas{routes?.length ? ` · ${routes.length}` : ''}</div>
      <div className="screens">
        {routes === null && <span className="skeleton screens__skeleton" />}
        {routes?.length === 0 && <span className="screens__empty">No se detectaron rutas (Next, SvelteKit, Astro o React Router).</span>}
        {routes?.map((r) => {
          const dynamic = /\[|:/.test(r.route);
          return (
            <div key={r.route} className={`screens__row ${current === r.route ? 'is-active' : ''}`}>
              <button className="screens__go" onClick={() => onGo(r.route)} title={dynamic ? 'Ruta dinámica: completa el parámetro en la URL' : r.route}>
                <span className={`mono ${dynamic ? 'screens__dyn' : ''}`}>{r.route}</span>
              </button>
              <button className="ic screens__file" onClick={() => openFile(r)} title="Abrir el archivo"><IconFileCode size={12} /></button>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function DesignMode() {
  const { design, setDesign, sizes } = useWorkbenchStore();
  const panels = useWorkbenchStore((st) => st.modePanels.design);
  const [draft, setDraft] = useState(design.url);
  const [reloadKey, setReloadKey] = useState(0);
  const device = DEVICES.find((d) => d.id === design.device) || DEVICES[1];
  const w = design.landscape ? device.h : device.w;
  const h = design.landscape ? device.w : device.h;

  useEffect(() => setDraft(design.url), [design.url]);

  const bridge = usePreviewBridge(design.url);
  const [inspecting, setInspecting] = useState(false);
  const [rightTab, setRightTab] = useState('agent');
  useEffect(() => { bridge.post({ type: 'inspect', on: inspecting }); }, [inspecting, bridge.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (bridge.selected) setRightTab('inspector'); }, [bridge.selected]);
  const viewContext = `${design.url} a ${w}×${h} (${device.name}, breakpoint ${breakpointOf(w)})`;

  const commitUrl = () => {
    const url = normalizeUrl(draft);
    setDesign({ url });
    setReloadKey((k) => k + 1);
  };

  const askAgent = (el = null) => {
    const where = el
      ? `En el elemento ${el.name}${el.component && el.component !== el.name ? ` (componente ${el.component})` : ''}${el.source ? ` de ${el.source.file}:${el.source.line}` : ''}, ${el.rect.w}×${el.rect.h}, de la vista ${viewContext}: `
      : `En la vista ${viewContext}: `;
    setRightTab('agent');
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('lixbon:compose', { detail: { text: where } })));
  };

  return (
    <div className="wb wb--design">
      <Collapse open={panels.left} size={sizes.inspector + GAP}>
        <Panel id="devices" className="devices">
          <div className="panelhead"><span className="panelhead__title">Vista previa</span></div>
          <div className="devices__body scroll">
            <label className="fieldlabel">
              URL
              <div className="field field--strong">
                <input
                  className="mono"
                  value={draft}
                  placeholder="localhost:3000"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitUrl(); }}
                  onBlur={commitUrl}
                />
              </div>
            </label>
            <div className="devices__ports">
              {[3000, 5173, 4321, 8080].map((p) => (
                <button key={p} className="chip" onClick={() => { setDesign({ url: `http://localhost:${p}` }); setReloadKey((k) => k + 1); }}>:{p}</button>
              ))}
            </div>

            <Screens
            url={design.url}
            onGo={(route) => {
              let origin = 'http://localhost:3000';
              try { origin = new URL(design.url).origin; } catch { /* se queda el puerto por defecto */ }
              setDesign({ url: origin + route });
              setReloadKey((k) => k + 1);
            }}
          />

          <Layers bridge={bridge} />

          <div className="fieldlabel">Dispositivo</div>
            <div className="devices__list">
              {DEVICES.map((d) => (
                <button
                  key={d.id}
                  className={`devrow ${d.id === device.id ? 'is-active' : ''}`}
                  onClick={() => setDesign({ device: d.id })}
                >
                  <span>{d.name}</span>
                  <span className="mono devrow__dims">{d.w} × {d.h}</span>
                </button>
              ))}
            </div>

            <div className="fieldlabel">Breakpoints</div>
            <div className="bps mono">
              {BREAKPOINTS.map(([n, px]) => (
                <div key={n} className={`bps__row ${w >= px ? 'is-on' : ''}`}><span>{n}</span><span>≥ {px}</span></div>
              ))}
            </div>
          </div>
        </Panel>
        <Gutter sizeKey="inspector" />
      </Collapse>

      <Panel id="canvas" className="wb__grow canvas">
        <div className="canvas__bar">
          <Segmented
            value={device.group}
            onChange={(g) => setDesign({ device: GROUP_DEFAULT[g] })}
            width={88}
            options={[{ value: 'mobile', label: 'Móvil' }, { value: 'tablet', label: 'Tablet' }, { value: 'desktop', label: 'Escritorio' }]}
          />
          <span className="mono canvas__dims">{device.name} · {w} × {h} · {breakpointOf(w)}</span>
          <button className="ic" onClick={() => setDesign({ landscape: !design.landscape })} title="Rotar"><IconRotate size={15} /></button>
          <button
            className={`ic ${inspecting ? 'is-on' : ''}`}
            onClick={() => setInspecting((v) => !v)}
            disabled={!bridge.proxied}
            title={bridge.proxied ? 'Inspeccionar elementos' : 'Inspeccionar: necesita un servidor local en la app de escritorio'}
          >
            <IconCursor size={15} />
          </button>
          <div className="panelhead__fill" />
          <button className="lk canvas__ask" onClick={() => askAgent(bridge.selected)}>Pedir cambios al agente</button>
          <button className="ic" onClick={() => setReloadKey((k) => k + 1)} title="Recargar"><IconRefresh size={15} /></button>
          <button className="ic" onClick={() => design.url && openExternal(design.url)} title="Abrir en el navegador"><IconExternal size={15} /></button>
          <button
            className="lk mono canvas__zoom"
            onClick={() => setDesign({ zoom: ZOOMS[(ZOOMS.indexOf(design.zoom) + 1) % ZOOMS.length] })}
            title="Zoom"
          >
            {design.zoom === 'fit' ? 'Ajustar' : `${Math.round(design.zoom * 100)}%`}
          </button>
        </div>
        <Viewport url={design.url} src={bridge.src} frameRef={bridge.frameRef} device={device} landscape={design.landscape} zoom={design.zoom} reloadKey={reloadKey} />
      </Panel>

      <Collapse open={panels.right} size={sizes.agent + GAP} from="end">
        <Gutter sizeKey="agent" invert />
        <Panel id="agent" className="designright">
          <div className="designright__tabs">
            <Segmented size="sm" width={84} value={rightTab} onChange={setRightTab} options={[{ value: 'inspector', label: 'Inspector' }, { value: 'agent', label: 'Agente' }]} />
          </div>
          {rightTab === 'inspector'
            ? <InspectorPanel bridge={bridge} context={viewContext} onAsk={() => askAgent(bridge.selected)} />
            : <AgentPanel />}
        </Panel>
      </Collapse>
    </div>
  );
}
