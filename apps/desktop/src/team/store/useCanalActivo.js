import { useShallow } from 'zustand/react/shallow';
import { useTeamStore } from './teamStore';

// canalActivo() arma un objeto nuevo en cada llamada; sin la comparación
// superficial, React lo toma por un cambio y vuelve a pintar sin fin.
export const useCanalActivo = () => useTeamStore(useShallow((s) => s.canalActivo()));
