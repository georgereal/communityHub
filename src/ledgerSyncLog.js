/** In-app sync trace — row-by-row pull/import/push decisions (GCP-style console). */

const LEVEL_CLASS = {
    error: 'sync-log-drawer__level--error',
    warn: 'sync-log-drawer__level--warn',
    skip: 'sync-log-drawer__level--skip',
    parse: 'sync-log-drawer__level--parse',
    db: 'sync-log-drawer__level--db',
    info: 'sync-log-drawer__level--info',
};

/** Shared across HMR reloads and duplicate module instances. */
function store() {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    if (!g.__ledgerSyncLog) {
        g.__ledgerSyncLog = { entries: [], listeners: new Set(), mounted: false };
    }
    return g.__ledgerSyncLog;
}

function drawerEl() {
    return document.getElementById('sync-log-drawer');
}

function fabEl() {
    return document.getElementById('sync-log-drawer-fab');
}

function rowsEl() {
    return document.getElementById('sync-log-drawer-rows');
}

function countEl() {
    return document.getElementById('sync-log-drawer-count');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function clearSyncLog() {
    store().entries.length = 0;
    store().listeners.forEach((fn) => fn());
}

export function onSyncLog(fn) {
    store().listeners.add(fn);
    return () => store().listeners.delete(fn);
}

/**
 * @param {'info'|'skip'|'parse'|'db'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [detail]
 */
export function syncLog(level, message, detail = null) {
    const s = store();
    s.entries.push({ t: Date.now(), level, message, detail });
    if (s.entries.length > 2000) s.entries.splice(0, s.entries.length - 2000);
    s.listeners.forEach((fn) => fn());
    const tag = level.toUpperCase().padEnd(5);
    const extra = detail ? ` ${JSON.stringify(detail)}` : '';
    console.log(`[sync ${tag}] ${message}${extra}`);
}

export function getSyncLogEntries() {
    return store().entries.slice();
}

export function formatSyncLogLine(entry) {
    const time = new Date(entry.t).toLocaleTimeString('en-IN', { hour12: false });
    const tag = entry.level.toUpperCase().padEnd(5);
    let line = `[${time}] ${tag} ${entry.message}`;
    if (entry.detail) line += ` ${JSON.stringify(entry.detail)}`;
    return line;
}

export function getSyncLogText() {
    return store().entries.map(formatSyncLogLine).join('\n');
}

function renderDrawerRows() {
    const tbody = rowsEl();
    if (!tbody) return;

    const entries = store().entries;

    if (!entries.length) {
        tbody.innerHTML = '<tr class="sync-log-drawer__empty"><td colspan="3">No sync activity yet — click <strong>Sync now</strong> (step 4 or Finances) to see row-by-row output.</td></tr>';
    } else {
        tbody.innerHTML = entries.map((entry) => {
            const time = new Date(entry.t).toLocaleTimeString('en-IN', { hour12: false });
            const level = entry.level.toUpperCase();
            const levelClass = LEVEL_CLASS[entry.level] || LEVEL_CLASS.info;
            let msg = escapeHtml(entry.message);
            if (entry.detail) {
                msg += ` <span class="sync-log-drawer__detail">${escapeHtml(JSON.stringify(entry.detail))}</span>`;
            }
            return `<tr class="sync-log-drawer__row sync-log-drawer__row--${entry.level}">
                <td class="sync-log-drawer__time">${time}</td>
                <td class="sync-log-drawer__level ${levelClass}">${level}</td>
                <td class="sync-log-drawer__msg">${msg}</td>
              </tr>`;
        }).join('');
    }

    countEl()?.replaceChildren(document.createTextNode(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`));

    const body = drawerEl()?.querySelector('.sync-log-drawer__body');
    if (body) body.scrollTop = body.scrollHeight;
}

function setDrawerState(state) {
    const drawer = drawerEl();
    const fab = fabEl();
    if (!drawer) return;
    drawer.dataset.state = state;
    drawer.hidden = state === 'closed';
    if (fab) fab.hidden = state !== 'closed';
}

export function openSyncLogDrawer() {
    mountSyncLogDrawer();
    setDrawerState('open');
    renderDrawerRows();
}

export function closeSyncLogDrawer() {
    setDrawerState('closed');
}

export function toggleSyncLogDrawer() {
    const drawer = drawerEl();
    if (!drawer || drawer.hidden || drawer.dataset.state === 'closed') {
        openSyncLogDrawer();
    } else if (drawer.dataset.state === 'minimized') {
        setDrawerState('open');
    } else {
        setDrawerState('minimized');
    }
}

function wireDrawerResize() {
    const drawer = drawerEl();
    const handle = drawer?.querySelector('.sync-log-drawer__resize');
    if (!handle || handle.dataset.wired) return;
    handle.dataset.wired = '1';

    let startY = 0;
    let startH = 0;

    const onMove = (e) => {
        const dy = startY - e.clientY;
        const next = Math.min(Math.max(startH + dy, 120), window.innerHeight * 0.85);
        drawer.style.setProperty('--sync-log-drawer-height', `${next}px`);
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startH = drawer.getBoundingClientRect().height;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

/** Mount fixed bottom log viewer on document.body (survives panel re-renders). */
export function mountSyncLogDrawer() {
    const s = store();
    if (s.mounted && drawerEl()) {
        renderDrawerRows();
        return;
    }

    document.getElementById('sync-log-root')?.remove();
    s.mounted = true;

    const root = document.createElement('div');
    root.id = 'sync-log-root';
    root.innerHTML = `
      <div id="sync-log-drawer" class="sync-log-drawer" data-state="closed" hidden aria-live="polite">
        <div class="sync-log-drawer__resize" title="Drag to resize"></div>
        <header class="sync-log-drawer__header">
          <div class="sync-log-drawer__header-left">
            <i class="fa-solid fa-terminal" aria-hidden="true"></i>
            <span class="sync-log-drawer__title">Sync log</span>
            <span id="sync-log-drawer-count" class="sync-log-drawer__count">0 entries</span>
          </div>
          <div class="sync-log-drawer__actions">
            <button type="button" class="sync-log-drawer__btn" id="sync-log-drawer-clear" title="Clear log">Clear</button>
            <button type="button" class="sync-log-drawer__btn" id="sync-log-drawer-minimize" title="Minimize">Minimize</button>
            <button type="button" class="sync-log-drawer__btn sync-log-drawer__btn--icon" id="sync-log-drawer-close" title="Close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="sync-log-drawer__body">
          <table class="sync-log-drawer__table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Severity</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody id="sync-log-drawer-rows"></tbody>
          </table>
        </div>
      </div>
      <button type="button" id="sync-log-drawer-fab" class="sync-log-drawer-fab" hidden title="Open sync log">
        <i class="fa-solid fa-terminal"></i>
        <span>Sync log</span>
      </button>`;
    document.body.appendChild(root);

    document.getElementById('sync-log-drawer-clear')?.addEventListener('click', () => clearSyncLog());
    document.getElementById('sync-log-drawer-close')?.addEventListener('click', () => closeSyncLogDrawer());
    document.getElementById('sync-log-drawer-minimize')?.addEventListener('click', () => {
        const drawer = drawerEl();
        if (drawer?.dataset.state === 'minimized') setDrawerState('open');
        else setDrawerState('minimized');
    });
    fabEl()?.addEventListener('click', () => openSyncLogDrawer());

    wireDrawerResize();
    onSyncLog(renderDrawerRows);
    renderDrawerRows();
}

/** @deprecated Use mountSyncLogDrawer — kept for callers that pass a container id. */
export function renderSyncLogHtml() {
    mountSyncLogDrawer();
    openSyncLogDrawer();
    return onSyncLog(renderDrawerRows);
}

export function syncLogBounds(bounds, warnings = []) {
    if (!bounds) {
        syncLog('warn', 'No sheet bounds — header/footer limits may not apply');
        return;
    }
    syncLog('info', 'Sheet bounds', {
        headerRow: bounds.headerRow ?? null,
        footerRow: bounds.footerRow ?? null,
        rangeStartRow: bounds.rangeStartRow ?? 1,
        dataRowsInTable: bounds.footerRow && bounds.headerRow
            ? Math.max(0, bounds.footerRow - bounds.headerRow - 1)
            : null,
    });
    warnings.forEach((w) => syncLog('warn', w));
}
