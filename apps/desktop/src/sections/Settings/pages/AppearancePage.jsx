import { useEffect, useState } from 'react';
import { Icono } from '@lixbon/icons';
import { Segmented } from '../../../components/Segmented';
import { useTheme } from '../../../lib/theme';
import { UI_SCALES, readUiScale, setUiScale } from '../../../lib/uiScale';
import { PageHead, SectionHead } from '../SettingsParts';

const AppearanceIcon = props => <Icono nombre="paleta" {...props} />;

/** Los mismos ajustes de tema y escala, en la sección Apariencia del lienzo. */
export function AppearancePage() {
  const [theme, setTheme] = useTheme();
  const [scale, setScale] = useState(readUiScale);
  useEffect(() => {
    const onScale = event => setScale(event.detail);
    window.addEventListener('lixbon:ui-scale', onScale);
    return () => window.removeEventListener('lixbon:ui-scale', onScale);
  }, []);
  return <div className="spage">
    <PageHead icon={AppearanceIcon} title="Apariencia" sub="Cómo se ve el IDE." />
    <section className="ssec"><SectionHead label="Interfaz" /><div className="ssec ssec--card ssec--rows">
      <div className="srow"><div className="srow__text"><span className="srow__label">Tema</span><span className="srow__hint">Sistema sigue el modo claro u oscuro de tu equipo.</span></div><Segmented size="sm" width={64} value={theme} onChange={setTheme} options={[{value:'system',label:'Sistema'},{value:'light',label:'Claro'},{value:'dark',label:'Oscuro'}]} /></div>
      <div className="srow"><div className="srow__text"><span className="srow__label">Tamaño de la interfaz</span><span className="srow__hint">Todo el IDE y Lixbon Team. También con Ctrl + y Ctrl −; Ctrl 0 vuelve al predeterminado.</span></div><Segmented size="sm" width={48} value={scale} onChange={setUiScale} options={UI_SCALES.map(value=>({value,label:`${Math.round(value*100)}%`}))} /></div>
    </div></section>
  </div>;
}
