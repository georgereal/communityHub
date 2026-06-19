import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxy = env.VITE_API_PROXY || 'https://communityhub.evolyx.in';

  return {
    server: {
      proxy: {
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
      },
    },
  };
});
