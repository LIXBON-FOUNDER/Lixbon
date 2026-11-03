// Iconos de la web: todos salen de @lixbon/icons (shared/icons).
// Los nombres de siempre se quedan como envoltorios de <Icono>, así no cambia
// ninguna importación. `relleno` pinta la gemela rellena (ítem activo).
import { Icono, Interruptor as Int } from '@lixbon/icons';

export { Icono, IconoDoble, Interruptor, usePulso, NOMBRES } from '@lixbon/icons';

// Copiar: pasa a «hecho» mientras dura el aviso de copiado.
export const IconCopiar = ({ hecho, size = 18, className }) => <Int tipo="copiar" on={!!hecho} size={size} className={className} />;

const de = (nombre) => {
  const C = ({ size = 18, ...p }) => <Icono nombre={nombre} size={size} {...p} />;
  C.displayName = nombre;
  return C;
};

// Desplegable: la flecha gira al abrirse.
export const IconChevron = ({ open, size = 18, style, ...p }) => (
  <Icono nombre="abajo" size={size} {...p}
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .3s cubic-bezier(.25,1,.5,1)', ...style }} />
);

export const IconPlus = de('mas');
export const IconX = de('cerrar');
export const IconCheck = de('hecho');
export const IconMenu = de('menu');
export const IconDots = de('opciones');
export const IconUpDown = de('selector');
export const IconCaret = de('abajo');
export const IconArrowLeft = de('volver');
export const IconArrowDown = de('flecha-abajo');
export const IconArrowUp = de('arriba');
export const IconNext = de('siguiente');
export const IconSend = de('enviar');
export const IconSearch = de('buscar');
export const IconRefresh = de('refrescar');
export const IconExternal = de('externo');
export const IconLink = de('enlace');
export const IconDownload = de('descargar');
export const IconUpload = de('subir');
export const IconShare = de('compartir');
export const IconCopy = de('copiar');
export const IconPencil = de('editar');
export const IconTrash = de('borrar');
export const IconLogout = de('salir');
export const IconStop = de('detener');
export const IconPlay = de('reproducir');
export const IconPause = de('pausa');
export const IconHistory = de('historial');
export const IconChat = de('chat');
export const IconGrid = de('cuadricula');
export const IconPanel = de('panel');
export const IconPanelRight = de('panel-der');
export const IconHome = de('inicio');
export const IconBook = de('libro');
export const IconTerminal = de('terminal');
export const IconCode = de('codigo');
export const IconWindow = de('navegador');
export const IconMonitor = de('monitor');
export const IconTablet = de('tableta');
export const IconUndo = de('deshacer');
export const IconRedo = de('rehacer');
export const IconRows = de('lista');
export const IconPhone = de('movil');
export const IconLayers = de('capas');
export const IconApps = de('apps');
export const IconLauncher = de('lanzador');
export const IconSliders = de('deslizadores');
export const IconGear = de('ajustes');
export const IconClip = de('clip');
export const IconFile = de('archivo');
export const IconImage = de('imagen');
export const IconCamera = de('camara');
export const IconMic = de('microfono');
export const IconGlobe = de('globo');
export const IconPointer = de('cursor');
export const IconUser = de('usuario');
export const IconMascota = de('mascota');
export const IconUsers = de('equipo');
export const IconShield = de('escudo');
export const IconCard = de('tarjeta');
export const IconBag = de('bolsa');
export const IconBolt = de('rayo');
export const IconChart = de('grafica');
export const IconTrend = de('tendencia');
export const IconNodes = de('nodos');
export const IconAlert = de('alerta');
export const IconCorazon = de('corazon');
export const IconCorreo = de('correo');
export const IconSun = de('claro');
export const IconMoon = de('oscuro');
export const IconPlanes = de('planes');
export const IconCli = de('cli');
export const IconIde = de('ide');
export const IconAgente = de('agente');
export const IconOrquestador = de('orquestador');
export const NavNuevo = de('nuevo');
export const NavBuscar = de('buscar');
export const NavPanel = de('panel');
export const NavChat = de('chat');
export const NavVisuals = de('visuals');
export const NavSkills = de('skills');
export const NavEspacios = de('carpeta');
export const NavApps = de('apps');
export const NavRemoto = de('remoto');
export const NavDocs = de('docs');
export const NavInicio = de('inicio');
export const NavHistorial = de('historial');
export const NavAjustes = de('ajustes');
export const NavUso = de('uso');
export const NavPlanes = de('planes');
export const NavIdioma = de('idioma');
export const NavSalir = de('salir');
export const NavAdmin = de('admin');
export const NavDonar = de('donar');
export const TemaClaro = de('claro');
export const TemaOscuro = de('oscuro');
export const TemaSistema = de('sistema');
