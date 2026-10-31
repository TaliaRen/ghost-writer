import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Xiaohongshu mini-tool container loads the page from an offline zip and
 * only runs classic scripts (no `type="module"`), so the built page references
 * a single deferred classic script. The same build also works on any static
 * host such as GitHub Pages.
 */
function classicScript(): Plugin {
  return {
    name: 'classic-script',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<script type="module" src=/g, '<script defer src=')
        .replace(/ crossorigin(?=[\s>])/g, '');
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), classicScript()],
  // Relative asset paths: required inside the zip, and lets the site work
  // from a sub-path such as https://<user>.github.io/ghost-writer/.
  base: command === 'build' ? './' : '/',
  build: {
    // Baseline: Android 8.1 WebView (Chrome 61).
    target: ['es2017', 'chrome61'],
    cssTarget: 'chrome61',
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  server: { port: 5178 },
}));
