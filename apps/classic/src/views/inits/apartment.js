import {
    renderResidents,
    populateResidentBlockFilter,
    exportResidentsExcel,
    syncResidentModalFields,
    openResidentModal,
    closeResidentModal,
    saveResident,
} from '../../residentView.js';
import { initResidentImport } from '../../residentImport.js';
import { getSelectedBlock } from '../../blockFilter.js';

let wired = false;

export default async function initApartmentView() {
    if (wired) return;
    wired = true;

    initResidentImport();

    document.getElementById('resident-refresh-btn')?.addEventListener('click', () => renderResidents());
    document.getElementById('resident-export-btn')?.addEventListener('click', () => exportResidentsExcel().catch((err) => alert(err?.message || 'Export failed.')));
    document.getElementById('resident-add-btn')?.addEventListener('click', () => openResidentModal(null));
    document.getElementById('resident-cancel-btn')?.addEventListener('click', () => closeResidentModal());
    document.getElementById('resident-save-btn')?.addEventListener('click', () => saveResident());
    document.getElementById('resident-kind')?.addEventListener('change', syncResidentModalFields);
    populateResidentBlockFilter();
    document.getElementById('resident-filter')?.addEventListener('input', () => renderResidents());
    document.getElementById('resident-kind-filter')?.addEventListener('change', () => renderResidents());
    document.getElementById('resident-residency-filter')?.addEventListener('change', () => renderResidents());
    document.getElementById('resident-primary-filter')?.addEventListener('change', () => renderResidents());
    document.addEventListener('block-filter-change', () => {
        const sel = document.getElementById('resident-block-filter');
        if (sel) sel.value = getSelectedBlock();
        if (document.getElementById('view-apartment')?.classList.contains('active')) renderResidents();
    });
}
