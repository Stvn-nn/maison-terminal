import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Port 1420 is the Tauri dev URL and is on the Python service's CORS allow-list.
// Preview uses the same port so the browser preview can reach the service too
// (Vite's default preview port 4173 is rejected by the service's CORS policy).
// Port 8000 stays reserved for the Python service.
const FRONTEND_PORT = 1420

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/python-core/**'] },
  },
  preview: {
    port: FRONTEND_PORT,
    strictPort: true,
  },
  envPrefix: ['VITE_'],
  build: {
    outDir: 'dist',
    // WebView2 (Chromium) is the only runtime target.
    target: 'chrome120',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    restoreMocks: true,
  },
})
