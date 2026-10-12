// AdeIcon.jsx — resuelve nombres de icono del ADE a los de components/Icons.jsx (importados, no modificados).
import {
  IconWarn, IconFolder, IconHistory, IconCpu, IconGear, IconTerminal, IconExternal, IconGitBranch, IconChevronRight,
  IconChevronLeft, IconCheck, IconX, IconRefresh, IconPlus, IconFile, IconShield, IconDevice, IconCode, IconChat,
} from '../../components/Icons';

const ICONOS = {
  attention: IconWarn, folder: IconFolder, history: IconHistory, cpu: IconCpu, gear: IconGear, terminal: IconTerminal,
  external: IconExternal, branch: IconGitBranch, next: IconChevronRight, prev: IconChevronLeft, check: IconCheck, x: IconX,
  refresh: IconRefresh, plus: IconPlus, file: IconFile, shield: IconShield, device: IconDevice, code: IconCode, chat: IconChat,
};

export function AdeIcon({ name, size = 16 }) {
  const Cmp = ICONOS[name] || IconFile;
  return <Cmp size={size} />;
}
