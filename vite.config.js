import { defineConfig } from 'vite';

export default defineConfig({
  base: '/openworld-minutes/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
