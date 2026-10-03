// GitPage.jsx — Ajustes → Git: quién redacta los mensajes de commit y en qué idioma.
import { useWorkbenchStore } from '../../../store/workbenchStore';
import { Segmented } from '../../../components/Segmented';
import { Select } from '../../../components/Select';
import { IconGitBranch } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';

const LANGS = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'pt', label: 'Português' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
];

export function GitPage() {
  const commitMsg = useWorkbenchStore((s) => s.commitMsg);
  const setOption = useWorkbenchStore((s) => s.setCommitMsgOption);
  return (
    <div className="spage">
      <PageHead icon={IconGitBranch} title="Git" sub="Cómo se generan los mensajes de commit." />
      <section className="ssec rise rise--1">
        <SectionHead label="Mensaje de commit" hint="«Generar mensaje» sigue Conventional Commits (feat, fix, docs…) a partir de los cambios preparados." />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Agente</span>
              <span className="srow__hint">Claude Code usa tu cuenta de Claude con el modelo Haiku; Lixbon, el modelo elegido en el chat.</span>
            </div>
            <Segmented size="sm" width={92} value={commitMsg.engine} onChange={(v) => setOption('engine', v)}
              options={[{ value: 'lixbon', label: 'Lixbon' }, { value: 'claude', label: 'Claude Code' }]} />
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Idioma</span>
              <span className="srow__hint">Idioma de la descripción. El tipo y el ámbito (feat, fix…) siempre van en inglés.</span>
            </div>
            <Select value={commitMsg.lang} onChange={(v) => setOption('lang', v)} options={LANGS} />
          </div>
        </div>
      </section>
    </div>
  );
}
