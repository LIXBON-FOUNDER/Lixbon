import { LogoMark, ClaudeMark } from '../../components/Logo';
import { providerName } from './agentIdentity';

/** Claude y Lixbon tienen marca propia; el resto, su inicial, para no inventar logos ajenos. */
export function ProviderMark({ provider, size = 12 }) {
  if (provider === 'claude') return <ClaudeMark size={size} />;
  if (provider === 'lixbon' || provider === 'lixbon-cli' || provider === 'coordinador') return <LogoMark size={size} />;
  return (
    <span className="providermark" style={{ width: size, height: size, fontSize: Math.max(8, size - 4) }} aria-hidden="true">
      {providerName(provider).charAt(0).toUpperCase()}
    </span>
  );
}
