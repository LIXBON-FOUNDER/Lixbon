import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // En dev la web corre en :5173 y el gateway en :8000 — mismo origen
      // vía proxy para que la cookie de sesión funcione sin CORS.
      '/api': 'http://localhost:8000',
      '/v1': 'http://localhost:8000',
    },
  },
})
