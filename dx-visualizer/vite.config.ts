import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
  },
  server: {
    proxy: {
      '/auth': 'http://localhost:3001',
    },
  },
  optimizeDeps: {
    exclude: ['lightningcss', 'caniuse-lite'],
  },
  build: {
    rollupOptions: {
      external: ['lightningcss', 'caniuse-lite'],
    },
  },
})
