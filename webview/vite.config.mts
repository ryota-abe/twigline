import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// The webview is bundled into one JS and one CSS. Fonts are emitted as separate files to match the CSP's font-src.
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/webview', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    // Do not include source maps in production (VSIX)
    sourcemap: process.env.NODE_ENV !== 'production',
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'index-[name].js',
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? '';
          if (name.endsWith('.css')) return 'index.css';
          return '[name][extname]';
        },
        codeSplitting: false,
      },
    },
  },
});
