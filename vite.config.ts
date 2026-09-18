import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the same build works at "/" (dev/preview,
  // cloudflared quick tunnels) and under a sub-path (GitHub Pages project
  // sites: https://<user>.github.io/<repo>/).
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // Allow exposing the local server through cloudflared quick tunnels.
    // Add your own domain here if you use a named tunnel.
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: {
    port: 4173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // The simulation core is deliberately DOM-free, so unit tests run in
    // plain Node. Browser-level coverage lives in tests/e2e (Playwright).
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    reporters: 'default',
  },
});
