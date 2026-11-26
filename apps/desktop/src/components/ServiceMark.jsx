import { BrandIcon, hasBrand } from '@lixbon/icons/brands';
import { Icono } from '@lixbon/icons';

/** Solo nombres de servicio reconocidos; un servidor privado conserva el icono genérico. */
export function ServiceMark({ name, size = 20 }) {
  return hasBrand(name) ? <BrandIcon name={name} size={size} /> : <Icono nombre="nodos" size={size} />;
}
