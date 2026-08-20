import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    // The CSP lives in a static <meta> tag, so it applies in dev too. A local
    // SSO backend on http://localhost:3001 is not covered by the production
    // connect-src allowlist, so fetches to it are blocked before they leave
    // the page. Widen connect-src for dev only; the placeholder is stripped
    // in production builds, leaving the CSP unchanged.
    {
      name: 'dev-csp-connect-src',
      transformIndexHtml: {
        order: 'pre',
        handler: (html, ctx) =>
          html.replace(
            '%VITE_DEV_CSP_CONNECT%',
            ctx.server ? 'http://localhost:* http://127.0.0.1:*' : ''
          ),
      },
    },
  ],
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
