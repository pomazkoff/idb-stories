import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Admin API — на том же origin, что и SPA (cookie сессии SameSite=Strict, без CORS).
// В dev Vite проксирует /admin/v1 на admin API; Host не меняется, чтобы проверка Origin
// и редиректы SSO работали на адресе dev-сервера (ADMIN_ORIGIN=http://localhost:5173).
const adminApiProxy = {
  '/admin/v1': { target: process.env.ADMIN_API_URL ?? 'http://localhost:8081', changeOrigin: false },
};

function productionCsp(mediaOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' ${mediaOrigin}`,
    `media-src 'self' ${mediaOrigin}`,
    `connect-src 'self' ${mediaOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Внутренние пакеты (@idb-stories/*) берутся из исходников.
    conditions: ['@idb-stories/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: adminApiProxy,
  },
  preview: {
    port: 4173,
    proxy: adminApiProxy,
    // Тот же строгий CSP, что отдаёт nginx в проде (ops/nginx/admin.conf.template):
    // `vite preview` позволяет проверить сборку на нарушения CSP локально.
    headers: { 'Content-Security-Policy': productionCsp(process.env.MEDIA_ORIGIN ?? 'http://localhost:9000') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // Строгий CSP (img-src без data:): никаких инлайновых data:-ассетов.
    assetsInlineLimit: 0,
    // Полифил modulepreload не нужен целевым браузерам; в index.html не должно быть инлайнового кода.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Библиотеки — отдельными чанками: меняются реже кода админки и дольше живут в кеше.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/zod/')) return 'zod';
          if (/\/(react|react-dom|scheduler|react-router)\//.test(id)) return 'react';
          return 'vendor';
        },
      },
    },
  },
});
