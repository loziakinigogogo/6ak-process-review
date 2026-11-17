import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Production assets live with the independently installable Node runtime.
  build: { outDir: fileURLToPath(new URL('../../skills/6ak-process-review/workbench/frontend/build', import.meta.url)), emptyOutDir: true },
  server: { host: '127.0.0.1' },
});
