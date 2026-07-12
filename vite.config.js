import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { viteApiDevPlugin } from './viteApiDev.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxy = env.VITE_API_PROXY || 'https://communityhub.evolyx.in';
  const useLocalApi = env.VITE_LOCAL_API !== '0';

  return {
    // Always register local api/*.js handlers when present; proxy only fills gaps (VITE_LOCAL_API=0).
    plugins: [viteApiDevPlugin(env)],
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
          microsoftAuth: resolve(__dirname, 'microsoft-auth.html'),
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
