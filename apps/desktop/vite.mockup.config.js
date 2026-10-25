// Configuración de Vite SOLO para ver la maqueta (`npx vite --config vite.mockup.config.js` desde apps/desktop). No es la del producto (vite.config.js queda intacto)
// y no genera build: sirve /mockup.html con datos ficticios.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { preserveSymlinks: true }, // permite que node_modules sea una junction a otro worktree
  clearScreen: false,
  server: { port: 5179, strictPort: true },
});
