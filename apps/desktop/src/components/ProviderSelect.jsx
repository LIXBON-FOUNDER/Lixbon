import { ProviderMark } from '../orch/agent/ProviderMark';
import { providerName } from '../orch/agent/agentIdentity';
import './ProviderSelect.css';

/** Conserva el select y el catálogo del Core; la marca no sustituye su nombre accesible. */
export function ProviderSelect({ providers, value, placeholder, className = '', ...props }) {
  const selected = providers.some(provider => provider.id === value);
  return <span className={`provider-select${selected ? ' has-mark' : ''} ${className}`}>
    {selected && <span className="provider-select__mark"><ProviderMark provider={value} size={16} /></span>}
    <select {...props} value={value}>
      {placeholder && <option value="">{placeholder}</option>}
      {providers.map(provider => <option key={provider.id} value={provider.id}>{providerName(provider.id)}</option>)}
    </select>
  </span>;
}
