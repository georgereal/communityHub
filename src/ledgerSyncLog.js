/** In-app sync trace — admin-only modal (opened on demand). */

const ADMIN_LOG_HOST_ID = 'admin-sync-log-host';

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
        g.__ledgerSyncLog = { entries: [], listeners: new Set(), runSink: null };
    }
    return g.__ledgerSyncLog;
}

/** Persist syncLog lines to ledger_sync_run_logs via active journal. */
export function setRunLogSink(sink) {
    store().runSink = sink || null;
}

export function getRunLogSink() {
    return store().runSink;
}

function modalEl() {
    return document.getElementById('sync-log-modal');
}

function drawerEl() {
    return document.getElementById('sync-log-drawer');
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
    try {
        s.runSink?.(level, message, detail);
    } catch (err) {
        console.warn('[sync log] run sink failed:', err);
    }
    const tag = level.toUpperCase().padEnd(5);
    const extra = detail ? ` ${JSON.stringify(detail)}` : '';
    console.log(`[sync ${tag}] ${message}${extra}`);
}

export function getSyncLogEntries() {
    return store().entries.slice();
}

/** Merge persisted run log lines into the in-browser modal (e.g. after server sync). */
export function appendSyncLogEntries(entries) {
    if (!entries?.length) return 0;
    const s = store();
    for (const entry of entries) {
        s.entries.push({
            t: entry.t ?? (entry.logged_at ? Date.parse(entry.logged_at) : Date.now()),
            level: entry.level || 'info',
            message: entry.message || '',
            detail: entry.detail ?? null,
        });
    }
    if (s.entries.length > 2000) s.entries.splice(0, s.entries.length - 2000);
    s.listeners.forEach((fn) => fn());
    return entries.length;
}

export async function hydrateSyncLogFromRun(supabase, runId) {
    if (!supabase || !runId) return 0;
    const { fetchSyncRunLogs } = await import('./ledgerSyncJournal.js');
    const logs = await fetchSyncRunLogs(supabase, runId);
    return appendSyncLogEntries(logs);
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
        tbody.innerHTML = '<tr class="sync-log-drawer__empty"><td colspan="3">No sync activity yet. <strong>Sync now (browser)</strong> streams here live; <strong>Test server sync</strong> loads logs here when the run finishes (or use <strong>Run history</strong>).</td></tr>';
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

function setModalOpen(open) {
    const modal = modalEl();
    if (!modal) return;
    modal.hidden = !open;
    document.body.classList.toggle('sync-log-modal-open', open);
}

export function openSyncLogDrawer() {
    if (!mountSyncLogDrawer()) return;
    setModalOpen(true);
    renderDrawerRows();
}

export function closeSyncLogDrawer() {
    setModalOpen(false);
}

export function toggleSyncLogDrawer() {
    if (modalEl()?.hidden !== false) openSyncLogDrawer();
    else closeSyncLogDrawer();
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
        const next = Math.min(Math.max(startH + dy, 160), window.innerHeight * 0.75);
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

/** Remove legacy global drawer (older builds mounted on body). */
export function teardownSyncLogDrawer() {
    closeSyncLogDrawer();
    document.getElementById('sync-log-root')?.remove();
    document.body.classList.remove('sync-log-modal-open');
}

/** Mount modal log viewer inside admin sync panel only. Returns false if host missing. */
export function mountSyncLogDrawer() {
    const host = document.getElementById(ADMIN_LOG_HOST_ID);
    if (!host) return false;

    if (host.querySelector('#sync-log-modal')) {
        renderDrawerRows();
        return true;
    }

    host.innerHTML = `
      <div id="sync-log-modal" class="sync-log-modal" hidden aria-live="polite" role="dialog" aria-labelledby="sync-log-drawer-title">
        <button type="button" class="sync-log-modal__backdrop" data-sync-log-close aria-label="Close sync log"></button>
        <div id="sync-log-drawer" class="sync-log-drawer">
          <div class="sync-log-drawer__resize" title="Drag to resize"></div>
          <header class="sync-log-drawer__header">
            <div class="sync-log-drawer__header-left">
              <i class="fa-solid fa-terminal" aria-hidden="true"></i>
              <span class="sync-log-drawer__title" id="sync-log-drawer-title">Sync log</span>
              <span id="sync-log-drawer-count" class="sync-log-drawer__count">0 entries</span>
            </div>
            <div class="sync-log-drawer__actions">
              <button type="button" class="sync-log-drawer__btn" id="sync-log-drawer-clear" title="Clear log">Clear</button>
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
      </div>`;

    host.querySelector('#sync-log-drawer-clear')?.addEventListener('click', () => clearSyncLog());
    host.querySelector('#sync-log-drawer-close')?.addEventListener('click', () => closeSyncLogDrawer());
    host.querySelector('[data-sync-log-close]')?.addEventListener('click', () => closeSyncLogDrawer());

    wireDrawerResize();
    onSyncLog(renderDrawerRows);
    renderDrawerRows();
    return true;
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
