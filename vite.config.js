import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base lets the build run under any path, e.g. behind a reverse proxy.
  base: './',
  // ENABLE_SIGNUP is exposed without the VITE_ prefix so it matches the deployment config.
  envPrefix: ['VITE_', 'ENABLE_SIGNUP'],
})
