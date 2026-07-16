import {
    renderRegistry,
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
import { initParkingReconcileUi } from '../../parkingReconcileUi.js';
import { withButtonBusy } from '../../buttonBusy.js';

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

    initParkingReconcileUi();
}
