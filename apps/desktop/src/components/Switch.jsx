// Switch.jsx — interruptor con el tirador que se estira al pulsar.
export function Switch({ checked, onChange, label, disabled = false }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  );
}
