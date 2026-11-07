import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Im Entwicklungsmodus laufen Oberflaeche (5173) und Panel (8080) getrennt.
// Der Proxy sorgt dafuer, dass beide fuer den Browser wie eine Adresse
// aussehen - sonst wuerde das Refresh-Cookie (SameSite=Strict) nicht mitgeschickt.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: process.env.NXP_API ?? 'http://127.0.0.1:8080', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Bibliotheken in eigene Dateien: aendert sich nur das Panel, bleiben
        // diese im Browser-Cache und muessen nach einem Update nicht neu laden.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'xterm';
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
});
