import { defineConfig } from 'vite';

// Imperial Crown 3D v3 build config.
// The production bundle is plain static files (base './') so the exact same
// output can be served from any static host or loaded inside the Android
// WebView shell from app assets.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: false,
    allowedHosts: true,
    hmr: { overlay: false }
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 8192,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // One chunk: the WebView fetches one JS file from the APK, no waterfall.
        inlineDynamicImports: true
      }
    }
  }
});
