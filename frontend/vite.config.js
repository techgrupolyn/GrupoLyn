import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        ws: true,
        configure: (proxy, options) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            const isEventStream = typeof req.url === 'string' && req.url === '/api/events';
            if (isEventStream) {
              proxyRes.headers['Content-Type'] = 'text/event-stream';
              proxyRes.headers['Cache-Control'] = 'no-cache';
              proxyRes.headers['Connection'] = 'keep-alive';
            }
          });
        },
      },
      '/webhook': 'http://localhost:3003',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          vendor: ['lucide-react'],
        },
      },
    },
    sourcemap: false,
    minify: 'esbuild',
  },
});
