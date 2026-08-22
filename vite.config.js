import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteApiDevPlugin } from './viteApiDev.js';
import {
    htmlInputMap,
    flattenHtmlPlugin,
    appHtmlDevPlugin,
} from './viteAppLayout.js';

function loginPathRewritePlugin() {
    return {
        name: 'login-path-rewrite',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url || '';
                if (url === '/login' || url.startsWith('/login?')) {
                    req.url = url.replace(/^\/login/, '/login.html');
                    next();
                    return;
                }
                const qIndex = url.indexOf('?');
                const pathOnly = qIndex === -1 ? url : url.slice(0, qIndex);
                const search = qIndex === -1 ? '' : url.slice(qIndex);
                if ((pathOnly === '/' || pathOnly === '/index.html') && search.includes('code=')) {
                    res.statusCode = 302;
                    res.setHeader('Location', `/login.html${search}`);
                    res.end();
                    return;
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
        plugins: [
            react(),
            viteApiDevPlugin(env),
            loginPathRewritePlugin(),
            appHtmlDevPlugin(),
            flattenHtmlPlugin(),
        ],
        resolve: {
            alias: {
                '@classic': resolve(__dirname, 'apps/classic/src'),
                '@new': resolve(__dirname, 'apps/new/src'),
                '@auth': resolve(__dirname, 'packages/auth'),
            },
        },
        server: {
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
                input: htmlInputMap(),
                output: {
                    entryFileNames: 'assets/[name]-[hash].js',
                    chunkFileNames: 'assets/chunk-[hash].js',
                    assetFileNames: 'assets/[name]-[hash][extname]',
                },
            },
        },
    };
});
