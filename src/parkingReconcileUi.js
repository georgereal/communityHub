/**
 * Parking Excel reconcile workspace (system vs file delta, grouped by flat).
 * Wired from registry view activation so it survives HMR / one-shot init misses.
 */
import {
    parseParkingExcelFile,
    buildParkingImportDiff,
    applyParkingImport,
} from './parkingImport.js';
import { withButtonBusy } from './buttonBusy.js';
import { supabase } from './store.js';

let pendingParkingImport = null;
let diffFilter = 'all';
let lastDiff = null;
let delegated = false;

const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const statusLabel = (status) => ({
    add: 'Add',
    update: 'Mismatch',
    remove: 'Remove',
    retain: 'Keep',
    unchanged: 'Matched',
    ignored: 'Ignored',
}[status] || status);

const els = () => ({
    view: document.getElementById('view-registry'),
    pageSections: document.querySelector('#view-registry .page-sections'),
    workspace: document.getElementById('parking-reconcile-workspace'),
    error: document.getElementById('parking-reconcile-error'),
    fileName: document.getElementById('parking-reconcile-file-name'),
    results: document.getElementById('parking-reconcile-results'),
    summary: document.getElementById('parking-reconcile-summary'),
    flats: document.getElementById('parking-reconcile-flats'),
    warn: document.getElementById('parking-reconcile-warn'),
    clearBtn: document.getElementById('parking-reconcile-clear-file'),
    fileInput: document.getElementById('xlsx-file'),
});

const showError = (msg) => {
    const { error } = els();
    if (!error) return;
    if (msg) {
        error.style.display = 'block';
        error.textContent = msg;
    } else {
        error.style.display = 'none';
        error.textContent = '';
    }
};

const getMode = () => {
    const picked = document.querySelector('input[name="parking-reconcile-mode"]:checked');
    const value = picked?.value || 'merge';
    if (value === 'overwrite' || value === 'overwrite_bikes' || value === 'overwrite_cars') return value;
    return 'merge';
};

export function openParkingReconcileWorkspace() {
    const { view, pageSections, workspace } = els();
    if (!supabase) {
        alert('Supabase is required for Excel reconcile.');
        return;
    }
    if (!workspace) {
        alert('Reconcile workspace failed to load. Hard-refresh the page (Cmd+Shift+R) and try again.');
        return;
    }
    view?.classList.add('registry--reconcile');
    if (pageSections) pageSections.hidden = true;
    workspace.hidden = false;
    showError('');
    workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function closeParkingReconcileWorkspace() {
    const { view, pageSections, workspace, fileName, results, clearBtn, fileInput } = els();
    view?.classList.remove('registry--reconcile');
    if (workspace) workspace.hidden = true;
    if (pageSections) pageSections.hidden = false;
    pendingParkingImport = null;
    lastDiff = null;
    diffFilter = 'all';
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = 'No file selected';
    if (results) results.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    showError('');
    document.querySelectorAll('#parking-reconcile-filters .parking-reconcile__filter').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.diffFilter === 'all');
    });
}

const vehicleLine = (side, r) => {
    const v = side === 'system' ? r.system : r.file;
    if (!v) return '';
    const parking = side === 'system' ? r.parkingNoSystem : r.parkingNoFile;
    const showDelta = r.changes?.length
        || r.status === 'add'
        || r.status === 'remove'
        || r.status === 'retain'
        || r.status === 'update';
    const delta = r.changes?.length
        ? `<ul class="parking-reconcile__delta">${r.changes.map((c) =>
            `<li><strong>${esc(c.field)}:</strong> ${esc(c.from)} → ${esc(c.to)}</li>`).join('')}</ul>`
        : (showDelta && r.note ? `<div class="parking-reconcile-veh__note">${esc(r.note)}</div>` : '');
    return `
    <div class="parking-reconcile-veh parking-reconcile-veh--${esc(r.status)}">
      <div class="parking-reconcile-veh__top">
        <span class="parking-reconcile__badge parking-reconcile__badge--${esc(r.status)}">${esc(statusLabel(r.status))}</span>
        <strong class="parking-reconcile-veh__plate">${esc(r.plate)}</strong>
        <span class="parking-reconcile-veh__type">${esc(r.type)}</span>
      </div>
      <div class="parking-reconcile-veh__meta">Parking ${esc(parking || '—')}</div>
      ${delta}
    </div>`;
};

function renderDiffTable() {
    const { flats: flatsEl } = els();
    if (!lastDiff || !flatsEl) return;

    const groups = (lastDiff.byFlat || []).map((g) => {
        const rows = diffFilter === 'all'
            ? g.rows
            : g.rows.filter((r) => r.status === diffFilter);
        return { ...g, rows };
    }).filter((g) => g.rows.length > 0);

    if (!groups.length) {
        flatsEl.innerHTML = `<p class="nb-muted" style="padding:0.75rem;">No flats in this filter.</p>`;
        return;
    }

    flatsEl.innerHTML = groups.map((g) => {
        const c = {
            add: g.rows.filter((r) => r.status === 'add').length,
            update: g.rows.filter((r) => r.status === 'update').length,
            unchanged: g.rows.filter((r) => r.status === 'unchanged').length,
            remove: g.rows.filter((r) => r.status === 'remove').length,
            retain: g.rows.filter((r) => r.status === 'retain').length,
        };
        const chips = [
            c.add ? `<span class="parking-reconcile-flat__chip parking-reconcile-flat__chip--add">${c.add} add</span>` : '',
            c.update ? `<span class="parking-reconcile-flat__chip parking-reconcile-flat__chip--update">${c.update} mismatch</span>` : '',
            c.unchanged ? `<span class="parking-reconcile-flat__chip">${c.unchanged} matched</span>` : '',
            c.remove ? `<span class="parking-reconcile-flat__chip parking-reconcile-flat__chip--remove">${c.remove} remove</span>` : '',
            c.retain ? `<span class="parking-reconcile-flat__chip parking-reconcile-flat__chip--retain">${c.retain} keep</span>` : '',
        ].filter(Boolean).join('');

        const systemItems = g.rows
            .filter((r) => r.system && String(r.unitSystem || '').toUpperCase() === g.flat)
            .sort((a, b) => a.plate.localeCompare(b.plate))
            .map((r) => vehicleLine('system', r))
            .join('') || `<p class="parking-reconcile-flat__empty">No system vehicles on this flat</p>`;

        const fileItems = g.rows
            .filter((r) => r.file && String(r.unitFile || '').toUpperCase() === g.flat)
            .sort((a, b) => a.plate.localeCompare(b.plate))
            .map((r) => vehicleLine('file', r))
            .join('') || `<p class="parking-reconcile-flat__empty">No file vehicles for this flat</p>`;

        const hasAction = g.rows.some((r) => r.status === 'add' || r.status === 'remove' || r.status === 'update');
        return `
      <details class="parking-reconcile-flat${hasAction ? ' parking-reconcile-flat--action' : ''}" ${hasAction || diffFilter !== 'all' ? 'open' : ''}>
        <summary class="parking-reconcile-flat__summary">
          <span class="parking-reconcile-flat__name">${esc(g.flat)}</span>
          <span class="parking-reconcile-flat__chips">${chips || '<span class="parking-reconcile-flat__chip">no changes</span>'}</span>
        </summary>
        <div class="parking-reconcile-flat__grid">
          <div class="parking-reconcile-flat__col">
            <h4 class="parking-reconcile-flat__col-title">In system</h4>
            ${systemItems}
          </div>
          <div class="parking-reconcile-flat__col">
            <h4 class="parking-reconcile-flat__col-title">In file</h4>
            ${fileItems}
          </div>
        </div>
      </details>`;
    }).join('');
}

function renderReconcileDiff() {
    if (!pendingParkingImport) return;
    const mode = getMode();
    lastDiff = buildParkingImportDiff(pendingParkingImport, mode);
    const c = lastDiff.counts;
    const { summary, warn, results } = els();
    if (summary) {
        summary.innerHTML = `
      <div class="parking-reconcile__stat"><b>${c.flatCount ?? 0}</b><span>Flats</span></div>
      <div class="parking-reconcile__stat parking-reconcile__stat--add"><b>${c.add}</b><span>To add</span></div>
      <div class="parking-reconcile__stat parking-reconcile__stat--update"><b>${c.update}</b><span>Mismatches</span></div>
      <div class="parking-reconcile__stat"><b>${c.unchanged}</b><span>Matched / retained</span></div>
      <div class="parking-reconcile__stat parking-reconcile__stat--remove"><b>${c.remove}</b><span>To remove</span></div>
      <div class="parking-reconcile__stat parking-reconcile__stat--retain"><b>${c.retain}</b><span>System-only</span></div>
    `;
    }
    if (warn) {
        if (mode === 'overwrite') {
            warn.hidden = false;
            warn.textContent = `Overwrite will delete ${c.remove} vehicle(s) not in the file (Change Log), then load the spreadsheet.`;
        } else if (mode === 'overwrite_bikes') {
            warn.hidden = false;
            warn.textContent = `Replace bikes: delete ${c.remove} bike(s) (Change Log), keep cars, import bikes from file.`;
        } else if (mode === 'overwrite_cars') {
            warn.hidden = false;
            warn.textContent = `Replace cars: delete ${c.remove} car(s) (Change Log), keep bikes, import cars from file.`;
        } else if (c.update || c.add) {
            warn.hidden = false;
            warn.textContent = `Merge will add ${c.add} and update ${c.update} vehicle(s). ${c.retain} system-only record(s) stay.`;
        } else {
            warn.hidden = true;
            warn.textContent = '';
        }
    }
    if (results) results.hidden = false;
    renderDiffTable();
}

function clearFile() {
    const { fileName, results, clearBtn, fileInput } = els();
    pendingParkingImport = null;
    lastDiff = null;
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = 'No file selected';
    if (results) results.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    showError('');
}

async function onFileChosen(file) {
    if (!file) return;
    showError('');
    try {
        const parsed = await parseParkingExcelFile(file);
        pendingParkingImport = parsed;
        const { fileName, clearBtn } = els();
        if (fileName) fileName.textContent = file.name;
        if (clearBtn) clearBtn.hidden = false;
        openParkingReconcileWorkspace();
        renderReconcileDiff();
    } catch (err) {
        showError(err?.message || 'Could not read that Excel file.');
    }
}

async function applyImport() {
    if (!pendingParkingImport) return;
    const mode = getMode();
    if (mode === 'overwrite') {
        if (!confirm('This will delete ALL vehicles for the active apartment (each delete is logged in Change Log) and replace them with the spreadsheet. Continue?')) return;
    } else if (mode === 'overwrite_bikes') {
        if (!confirm('This will delete ALL bike records for the active apartment (logged in Change Log), keep cars, and import bikes from the spreadsheet. Continue?')) return;
    } else if (mode === 'overwrite_cars') {
        if (!confirm('This will delete ALL car records for the active apartment (logged in Change Log), keep bikes, and import cars from the spreadsheet. Continue?')) return;
    }
    const applyBtn = document.getElementById('parking-reconcile-apply');
    showError('');
    await withButtonBusy(applyBtn, 'Importing…', async () => {
        const result = await applyParkingImport(pendingParkingImport, mode);
        const { processAnalytics, renderRegistry } = await import('./registry.js');
        const { refreshAuditBadge } = await import('./vehicleAudit.js');
        processAnalytics();
        renderRegistry();
        void refreshAuditBadge();
        closeParkingReconcileWorkspace();
        if (result.skippedRegistryMeta) {
            alert(
                'Import completed for units and vehicles, but RFID/sticker columns are missing in Supabase.\n\n' +
                'Open Supabase → SQL Editor and run supabase_vehicle_rfid_sticker.sql, then re-import to save sticker/RFID data.',
            );
        } else {
            const done =
                mode === 'overwrite' ? 'overwritten'
                    : mode === 'overwrite_bikes' ? 'bikes replaced'
                        : mode === 'overwrite_cars' ? 'cars replaced'
                            : 'merged';
            alert(`Parking registry ${done} successfully. Check Change Log (grouped by flat) for deletes and inserts.`);
        }
    }).catch((err) => showError(err?.message || 'Import failed.'));
}

/**
 * Idempotent: safe to call on every registry view activation.
 */
export function initParkingReconcileUi() {
    window.openParkingReconcileWorkspace = openParkingReconcileWorkspace;
    window.closeParkingReconcileWorkspace = closeParkingReconcileWorkspace;

    const fileInput = document.getElementById('xlsx-file');
    if (fileInput) {
        fileInput.onchange = (e) => {
            void onFileChosen(e.target.files?.[0]);
        };
    }

    if (delegated) return;
    delegated = true;

    document.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;

        if (t.closest('#registry-import-xlsx')) {
            e.preventDefault();
            openParkingReconcileWorkspace();
            return;
        }
        if (t.closest('#parking-reconcile-back')) {
            e.preventDefault();
            closeParkingReconcileWorkspace();
            return;
        }
        if (t.closest('#parking-reconcile-choose-file')) {
            e.preventDefault();
            document.getElementById('xlsx-file')?.click();
            return;
        }
        if (t.closest('#parking-reconcile-clear-file')) {
            e.preventDefault();
            clearFile();
            return;
        }
        if (t.closest('#parking-reconcile-apply')) {
            e.preventDefault();
            void applyImport();
            return;
        }
        const filterBtn = t.closest('#parking-reconcile-filters [data-diff-filter]');
        if (filterBtn) {
            e.preventDefault();
            diffFilter = filterBtn.dataset.diffFilter || 'all';
            document.querySelectorAll('#parking-reconcile-filters .parking-reconcile__filter').forEach((el) => {
                el.classList.toggle('active', el === filterBtn);
            });
            renderDiffTable();
        }
    });

    document.addEventListener('change', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.matches('input[name="parking-reconcile-mode"]') && pendingParkingImport) {
            renderReconcileDiff();
        }
    });
}
