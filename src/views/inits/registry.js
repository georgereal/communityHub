import {
    renderRegistry,
    processAnalytics,
    handleCSVImport,
    downloadVehicleRegistryXlsx,
    addCommunityPoolSlot,
    openCapacityModal,
    closeCapacityModal,
    applyCapacityDefaultsToAll,
    saveCapacityAllocation,
    refreshCapacityUnitList,
} from '../../registry.js';
import {
    openVehicleAuditModal,
    closeVehicleAuditModal,
    renderVehicleAuditModal,
    downloadPendingAuditCsv,
    markAllPendingVehicleAuditSynced,
    refreshAuditBadge,
} from '../../vehicleAudit.js';
import {
    parseParkingExcelFile,
    buildImportPreview,
    applyParkingImport,
} from '../../parkingImport.js';
import { withButtonBusy } from '../../buttonBusy.js';
import { supabase } from '../../store.js';

let wired = false;

export default async function initRegistryView() {
    if (wired) return;
    wired = true;

    const preventSearchAutofill = (el) => {
        if (!el) return;
        el.setAttribute('readonly', 'readonly');
        const unlock = () => {
            el.removeAttribute('readonly');
            el.removeEventListener('focus', unlock);
        };
        el.addEventListener('focus', unlock);
    };

    const searchInput = document.getElementById('apt-search');
    if (searchInput) {
        preventSearchAutofill(searchInput);
        searchInput.oninput = () => renderRegistry();
    }
    preventSearchAutofill(document.getElementById('cash-search'));
    preventSearchAutofill(document.getElementById('pool-search-input'));

    const sortSelect = document.getElementById('registry-sort');
    if (sortSelect) sortSelect.onchange = () => renderRegistry();

    document.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            document.body.dataset.registryFilter = btn.dataset.filter;
            renderRegistry();
        };
    });

    const setRegistryFilter = (filter) => {
        document.body.dataset.registryFilter = filter;
        document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
        const pill = document.querySelector(`.filter-pill[data-filter="${filter}"]`);
        if (pill) pill.classList.add('active');
        renderRegistry();
        document.getElementById('registry-units')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const bindKpi = (valueId, filter) => {
        const el = document.getElementById(valueId);
        const card = el?.closest?.('.metric-card');
        if (!card) return;
        card.classList.add('metric-card--clickable');
        card.onclick = () => setRegistryFilter(filter);
    };

    bindKpi('kpi-overlimit-cars', 'OVERLIMIT_CARS');
    bindKpi('kpi-overlimit-bikes', 'OVERLIMIT_BIKES');
    bindKpi('kpi-cars', 'CARS');
    bindKpi('kpi-bikes', 'BIKES');

    const summaryFocusLabels = {
        cars: 'Community pool — Cars (EH)',
        bikes: 'Community pool — Bikes (BH)',
        rentals: 'Flat-to-flat rentals',
    };
    const summaryFocusTargets = {
        cars: 'pool-visualiser',
        bikes: 'bike-pool-visualiser',
        rentals: 'flat-rental-visualiser',
    };

    const summaries = document.getElementById('registry-summaries');
    const body = summaries?.querySelector('.page-section__body--summaries');
    const focusBar = document.getElementById('summary-focus-bar');
    const focusLabel = document.getElementById('summary-focus-label');
    const showAllBtn = document.getElementById('summary-show-all');

    const setSummaryFocus = (focus) => {
        if (!focus || focus === 'all') {
            body?.removeAttribute('data-focus');
            focusBar?.setAttribute('hidden', '');
            document.querySelectorAll('.ms-pill--jump').forEach((p) => p.classList.remove('is-active'));
            return;
        }
        if (body) body.dataset.focus = focus;
        focusBar?.removeAttribute('hidden');
        if (focusLabel) focusLabel.textContent = summaryFocusLabels[focus] || '';
        document.querySelectorAll('.ms-pill--jump').forEach((p) => {
            p.classList.toggle('is-active', p.dataset.summaryFocus === focus);
        });
    };

    const openSummaryFocus = (focus) => {
        summaries?.setAttribute('open', '');
        setSummaryFocus(focus);
        requestAnimationFrame(() => {
            document.getElementById(summaryFocusTargets[focus])?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    };

    document.querySelectorAll('.ms-pill--jump').forEach((btn) => {
        const stop = (e) => e.stopPropagation();
        btn.addEventListener('mousedown', stop);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const focus = btn.dataset.summaryFocus;
            const isActive = btn.classList.contains('is-active') && summaries?.open && body?.dataset.focus === focus;
            if (isActive) setSummaryFocus('all');
            else openSummaryFocus(focus);
        });
    });

    showAllBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setSummaryFocus('all');
    });

    summaries?.addEventListener('toggle', () => {
        if (!summaries.open) setSummaryFocus('all');
    });

    const csvFile = document.getElementById('csv-file');
    if (csvFile) {
        csvFile.onchange = (e) => {
            if (e.target.files.length > 0) handleCSVImport(e.target.files[0]);
        };
    }

    document.getElementById('registry-download-xlsx')?.addEventListener('click', () => {
        downloadVehicleRegistryXlsx().catch((err) => {
            console.error(err);
            alert('Download failed. Check the console for details.');
        });
    });

    document.getElementById('pool-add-car')?.addEventListener('click', () => void addCommunityPoolSlot('car'));
    document.getElementById('pool-add-bike')?.addEventListener('click', () => void addCommunityPoolSlot('bike'));
    document.getElementById('registry-base-capacity')?.addEventListener('click', openCapacityModal);
    document.getElementById('registry-change-log')?.addEventListener('click', () => void openVehicleAuditModal());
    document.getElementById('audit-log-close')?.addEventListener('click', closeVehicleAuditModal);
    document.getElementById('audit-pending-only')?.addEventListener('change', () => void renderVehicleAuditModal());
    document.getElementById('audit-export-csv')?.addEventListener('click', () => void downloadPendingAuditCsv());
    document.getElementById('audit-mark-synced')?.addEventListener('click', async () => {
        if (!confirm('Mark all pending vehicle changes as synced to the other system?')) return;
        const btn = document.getElementById('audit-mark-synced');
        await withButtonBusy(btn, 'Updating…', async () => {
            const { error } = await markAllPendingVehicleAuditSynced();
            if (error) throw new Error(error.message || 'Could not update sync status.');
            await renderVehicleAuditModal();
            await refreshAuditBadge();
        }).catch((err) => alert(err.message));
    });
    document.getElementById('capacity-close')?.addEventListener('click', closeCapacityModal);
    document.getElementById('capacity-cancel')?.addEventListener('click', closeCapacityModal);
    document.getElementById('capacity-apply-all')?.addEventListener('click', applyCapacityDefaultsToAll);
    document.getElementById('capacity-save')?.addEventListener('click', () => {
        void withButtonBusy(document.getElementById('capacity-save'), 'Saving…', saveCapacityAllocation);
    });
    document.getElementById('capacity-search')?.addEventListener('input', refreshCapacityUnitList);

    const parkingImportModal = document.getElementById('parking-import-modal');
    const parkingImportStepPick = document.getElementById('parking-import-step-pick');
    const parkingImportStepPreview = document.getElementById('parking-import-step-preview');
    const parkingImportError = document.getElementById('parking-import-error');
    const parkingImportSummary = document.getElementById('parking-import-summary');
    const parkingImportWarn = document.getElementById('parking-import-warn');
    const parkingImportFileName = document.getElementById('parking-import-file-name');
    const xlsxFileInput = document.getElementById('xlsx-file');
    let pendingParkingImport = null;

    const showParkingImportError = (msg) => {
        if (!parkingImportError) return;
        if (msg) {
            parkingImportError.style.display = 'block';
            parkingImportError.textContent = msg;
        } else {
            parkingImportError.style.display = 'none';
            parkingImportError.textContent = '';
        }
    };

    const resetParkingImportModal = () => {
        pendingParkingImport = null;
        if (parkingImportStepPick) parkingImportStepPick.style.display = 'block';
        if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'none';
        showParkingImportError('');
        if (xlsxFileInput) xlsxFileInput.value = '';
    };

    const openParkingImportModal = () => {
        if (!supabase) return alert('Supabase is required for Excel reconcile.');
        resetParkingImportModal();
        parkingImportModal?.classList.add('active');
    };

    const closeParkingImportModal = () => {
        parkingImportModal?.classList.remove('active');
        resetParkingImportModal();
    };

    const getParkingImportMode = () => {
        const picked = document.querySelector('input[name="parking-import-mode"]:checked');
        return picked?.value === 'overwrite' ? 'overwrite' : 'merge';
    };

    const renderParkingPreview = (parsed, mode, fileName) => {
        const preview = buildImportPreview(parsed, mode);
        if (parkingImportFileName) parkingImportFileName.textContent = fileName;
        if (parkingImportSummary) {
            parkingImportSummary.innerHTML = `
        <div><strong>Mode:</strong> ${mode === 'overwrite' ? 'Overwrite' : 'Merge'}</div>
        <div><strong>Rows parsed:</strong> ${preview.rowCount}</div>
        <div><strong>Units:</strong> ${preview.unitCount} (${preview.newUnits} new, ${preview.updatedUnits} updated)</div>
        <div><strong>Vehicles:</strong> ${preview.vehicleCount} (${preview.carCount ?? 0} cars, ${preview.bikeCount ?? 0} bikes)</div>
        <div><strong>Changes:</strong> ${preview.newVehicles} new, ${preview.updatedVehicles} to update</div>
        <div><strong>Sticker / RFID rows:</strong> ${preview.withSticker ?? 0} with sticker, ${preview.withRfid ?? 0} with RFID data</div>
        <div><strong>Rented / external parking:</strong> ${preview.rentedParking ?? 0} vehicle(s) with Parking_No ≠ Flat</div>
        ${mode === 'overwrite' && preview.removedVehicles > 0
            ? `<div style="color:#b45309;"><strong>Will remove:</strong> ${preview.removedVehicles} existing vehicle(s) not in file</div>`
            : ''}
      `;
        }
        if (parkingImportWarn) {
            if (mode === 'overwrite') {
                parkingImportWarn.style.display = 'block';
                parkingImportWarn.textContent =
                    'Overwrite deletes all current vehicles for this apartment, then loads vehicles from the spreadsheet.';
            } else {
                parkingImportWarn.style.display = 'none';
                parkingImportWarn.textContent = '';
            }
        }
        if (parkingImportStepPick) parkingImportStepPick.style.display = 'none';
        if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'block';
    };

    document.getElementById('registry-import-xlsx')?.addEventListener('click', openParkingImportModal);
    document.getElementById('parking-import-close')?.addEventListener('click', closeParkingImportModal);
    document.getElementById('parking-import-cancel')?.addEventListener('click', closeParkingImportModal);
    document.getElementById('parking-import-back')?.addEventListener('click', () => {
        if (parkingImportStepPick) parkingImportStepPick.style.display = 'block';
        if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'none';
        showParkingImportError('');
    });
    document.getElementById('parking-import-choose-file')?.addEventListener('click', () => xlsxFileInput?.click());

    if (xlsxFileInput) {
        xlsxFileInput.onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            showParkingImportError('');
            try {
                const parsed = await parseParkingExcelFile(file);
                pendingParkingImport = parsed;
                renderParkingPreview(parsed, getParkingImportMode(), file.name);
            } catch (err) {
                showParkingImportError(err?.message || 'Could not read that Excel file.');
            }
        };
    }

    document.getElementById('parking-import-apply')?.addEventListener('click', async () => {
        if (!pendingParkingImport) return;
        const mode = getParkingImportMode();
        if (mode === 'overwrite') {
            const ok = confirm(
                'This will delete ALL vehicles for the active apartment and replace them with the spreadsheet. Continue?',
            );
            if (!ok) return;
        }
        const applyBtn = document.getElementById('parking-import-apply');
        showParkingImportError('');
        await withButtonBusy(applyBtn, 'Importing…', async () => {
            const result = await applyParkingImport(pendingParkingImport, mode);
            processAnalytics();
            renderRegistry();
            void refreshAuditBadge();
            closeParkingImportModal();
            if (result.skippedRegistryMeta) {
                alert(
                    'Import completed for units and vehicles, but RFID/sticker columns are missing in Supabase.\n\n' +
                    'Open Supabase → SQL Editor and run supabase_vehicle_rfid_sticker.sql, then re-import to save sticker/RFID data.',
                );
            } else {
                alert(`Parking registry ${mode === 'overwrite' ? 'overwritten' : 'merged'} successfully.`);
            }
        }).catch((err) => showParkingImportError(err?.message || 'Import failed.'));
    });
}
