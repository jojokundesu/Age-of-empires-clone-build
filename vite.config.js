import { defineConfig } from 'vite';

// Imperial Crown 3D build config.
// The production bundle is plain static files (base './') so the exact same
// output can be:
//   1. served from GitHub Pages / any static host,
//   2. loaded inside the Android WebView shell from app assets.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Arena / e2b preview proxies through an arbitrary host — allow everything.
    allowedHosts: true,
    hmr: { overlay: false }
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // Keep the whole game in one chunk so the WebView only fetches one JS file.
        manualChunks: undefined,
        inlineDynamicImports: true
      }
    }
  }
});
