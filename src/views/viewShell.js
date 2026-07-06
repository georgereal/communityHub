/** Lazy-mount view HTML templates and track mounted views. */

const mountedViews = new Map();
const mountPromises = new Map();

const htmlModules = import.meta.glob('./html/*.html', { query: '?raw', import: 'default' });
const initModules = import.meta.glob('./inits/*.js');

function viewIdFromPath(path) {
    return path.replace('./html/', '').replace('.html', '');
}

export function isViewMounted(viewId) {
    return mountedViews.has(viewId);
}

export function getViewElement(viewId) {
    return mountedViews.get(viewId) || document.getElementById(`view-${viewId}`);
}

export async function ensureViewMounted(viewId) {
    if (mountedViews.has(viewId)) return mountedViews.get(viewId);
    if (mountPromises.has(viewId)) return mountPromises.get(viewId);

    const promise = (async () => {
        const key = `./html/${viewId}.html`;
        const loader = htmlModules[key];
        if (!loader) throw new Error(`Unknown view template: ${viewId}`);

        const html = await loader();
        const container = document.getElementById('app-views');
        if (!container) throw new Error('Missing #app-views mount point.');

        const wrapper = document.createElement('div');
        wrapper.innerHTML = String(html).trim();
        const section = wrapper.firstElementChild;
        if (!section) throw new Error(`View template ${viewId} is empty.`);

        container.appendChild(section);
        mountedViews.set(viewId, section);

        const initKey = `./inits/${viewId}.js`;
        const initLoader = initModules[initKey];
        if (initLoader) {
            try {
                const mod = await initLoader();
                await mod.default?.(section);
            } catch (err) {
                console.warn(`[viewShell] Init failed for ${viewId}:`, err);
            }
        }

        return section;
    })();

    mountPromises.set(viewId, promise);
    try {
        return await promise;
    } catch (err) {
        mountPromises.delete(viewId);
        throw err;
    }
}

export function hideAllViews() {
    document.querySelectorAll('#app-views .content-view').forEach((el) => el.classList.remove('active'));
}

export function showView(viewId) {
    hideAllViews();
    getViewElement(viewId)?.classList.add('active');
}

export function listMountedViews() {
    return [...mountedViews.keys()];
}
