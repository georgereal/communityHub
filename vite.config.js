import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteApiDevPlugin } from './viteApiDev.js';

function loginPathRewritePlugin() {
  return {
    name: 'login-path-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '';
        if (url === '/login' || url.startsWith('/login?')) {
          req.url = url.replace(/^\/login/, '/login.html');
        }
        next();
      });
    },
  };
}

/** SPA fallback for MPA React apps (deep links in Vite dev). */
function mpaSpaFallbackPlugin() {
  const prefixes = ['/residents', '/parking', '/units', '/admin'];
  return {
    name: 'mpa-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '';
        for (const prefix of prefixes) {
          if (url === prefix || url.startsWith(`${prefix}?`)) {
            req.url = `${prefix}/index.html`;
            break;
          }
          if (
            url.startsWith(`${prefix}/`)
            && !url.includes('.')
            && !url.startsWith(`${prefix}/index.html`)
          ) {
            req.url = `${prefix}/index.html`;
            break;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxy = env.VITE_API_PROXY || 'https://communityhub.evolyx.in';
  const useLocalApi = env.VITE_LOCAL_API !== '0';

  return {
    // Always register local api/*.js handlers when present; proxy only fills gaps (VITE_LOCAL_API=0).
    plugins: [react(), viteApiDevPlugin(env), loginPathRewritePlugin(), mpaSpaFallbackPlugin()],
    resolve: {
      alias: {
        '@classic': resolve(__dirname, 'apps/classic/src'),
        '@new': resolve(__dirname, 'apps/new/src'),
        '@auth': resolve(__dirname, 'packages/auth'),
      },
    },
    server: {
      // Prevent Vite from serving api/*.js as static modules (breaks POST /api/*).
      fs: {
        deny: ['**/api/**'],
      },
      proxy: useLocalApi
        ? undefined
        : {
            '/api': {
              target: apiProxy,
              changeOrigin: true,
              secure: true,
            },
          },
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          login: resolve(__dirname, 'login.html'),
          microsoftAuth: resolve(__dirname, 'microsoft-auth.html'),
          financeLedger: resolve(__dirname, 'finance/ledger.html'),
          financeReports: resolve(__dirname, 'finance/reports.html'),
          financeDocs: resolve(__dirname, 'finance/docs.html'),
          financeExpensePlan: resolve(__dirname, 'finance/expense-plan.html'),
          financeInvoicesRaised: resolve(__dirname, 'finance/invoices-raised.html'),
          financeBankRecon: resolve(__dirname, 'finance/bank-recon.html'),
          residents: resolve(__dirname, 'residents/index.html'),
          parking: resolve(__dirname, 'parking/index.html'),
          units: resolve(__dirname, 'units/index.html'),
          admin: resolve(__dirname, 'admin/index.html'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/chunk-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
