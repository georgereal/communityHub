/**
 * Mirrors vercel.json HTML rewrites for the long-running Node server.
 * Returns a relative path under dist/, or null to fall through to 404.
 */
export function resolveStaticPath(pathname) {
    const path = pathname.split('?')[0] || '/';

    if (path === '/login' || path.startsWith('/login?')) return '/login.html';

    const exact = {
        '/': '/home/index.html',
        '/home': '/home/index.html',
        '/new': '/home/index.html',
        '/new/home': '/home/index.html',
        '/residents': '/residents/index.html',
        '/new/residents': '/residents/index.html',
        '/parking': '/parking/index.html',
        '/new/parking': '/parking/index.html',
        '/units': '/units/index.html',
        '/new/units': '/units/index.html',
        '/admin': '/admin/index.html',
        '/new/admin': '/admin/index.html',
    };
    if (exact[path]) return exact[path];

    const prefixes = [
        ['/residents/', '/residents/index.html'],
        ['/new/residents/', '/residents/index.html'],
        ['/parking/', '/parking/index.html'],
        ['/new/parking/', '/parking/index.html'],
        ['/units/', '/units/index.html'],
        ['/new/units/', '/units/index.html'],
        ['/admin/', '/admin/index.html'],
        ['/new/admin/', '/admin/index.html'],
        ['/home/', '/home/index.html'],
        ['/new/home/', '/home/index.html'],
    ];
    for (const [prefix, file] of prefixes) {
        if (path.startsWith(prefix)) return file;
    }

    // /new/finance/* → /finance/* (static MPA under dist/finance)
    if (path === '/new/finance' || path.startsWith('/new/finance/')) {
        return path.replace(/^\/new\/finance/, '/finance') || '/finance';
    }

    return null;
}

export function contentTypeFor(filePath) {
    const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
    const map = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.map': 'application/json',
        '.txt': 'text/plain; charset=utf-8',
    };
    return map[ext] || 'application/octet-stream';
}
