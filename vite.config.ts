import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Relative asset paths in the build, so the site works from a sub-path
  // such as https://<user>.github.io/ghost-writer/.
  base: command === 'build' ? './' : '/',
  server: { port: 5178 },
}));
