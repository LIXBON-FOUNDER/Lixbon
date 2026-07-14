// Avatar.jsx — foto de perfil, o la inicial del nombre si no hay ninguna.
import { useState } from 'react';
import { avatarSrc } from '../lib/account';

export function Avatar({ user, serverUrl, size = 26, className = '' }) {
  const [broken, setBroken] = useState(false);
  const src = avatarSrc(serverUrl, user);
  const initial = (user?.first_name || user?.username || user?.email || '?')[0].toUpperCase();
  const style = { width: size, height: size };

  if (!src || broken) {
    return (
      <span className={`avatar avatar--initial ${className}`} style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }

  return (
    <img
      className={`avatar ${className}`}
      style={style}
      src={src}
      alt=""
      draggable={false}
      onError={() => setBroken(true)} // la foto se borró en otro sitio
    />
  );
}
