/**
 * Security gate portal — visitor entry, parcels, parking passes
 */
import './securityPortal.css';
import './visitors.css';
import { portalState, pullState } from './store.js';
import {
    refreshGate,
    initGate,
    renderGateLog,
    ensureGateContext,
} from './visitorGate.js';
import {
    renderGateWizard,
    renderPendingApprovalsPanel,
    initGateWizard,
} from './gateWizard.js';
import { createVisitorPass, revokeVisitorPass, getActiveVisitorPasses } from './parkingOps.js';

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

function updateSecClock() {
    const el = document.getElementById('sec-clock');
    if (!el) return;
    el.textContent = new Date().toLocaleString('en-IN', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export const renderSecurityGate = () => {
    renderGateWizard();
    renderPendingApprovalsPanel();
    refreshGate('sec');
};

export const renderSecurityLog = () => {
    const ctx = ensureGateContext('sec');
    renderGateLog('sec', {
        listId: 'sec-log-list',
        logFilter: ctx.logFilter,
        emptyMessages: {
            today: 'No entries logged today.',
            all: 'No visitor entries in the log.',
        },
    });
};

export const renderSecurityPasses = () => {
    const el = document.getElementById('sec-passes-list');
    if (!el) return;
    const passes = getActiveVisitorPasses();
    if (!passes.length) {
        el.innerHTML = '<p class="visitor-empty">No active visitor parking passes.</p>';
        return;
    }
    el.innerHTML = passes.map((p) => `<div class="visitor-pass-row">
      <strong>${esc(p.vehicle_reg)}</strong>
      <span>Flat ${esc(unitLabel(p.unit_id))}</span>
      <span>Until ${new Date(p.valid_until).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>
      <button type="button" class="btn btn-outline btn--small" data-revoke-pass="${p.id}">Revoke</button>
    </div>`).join('');
    el.querySelectorAll('[data-revoke-pass]').forEach((btn) => {
        btn.onclick = () => void revokeVisitorPass(btn.dataset.revokePass).then(() => renderSecurityPasses());
    });
};

export const renderSecuritySubview = (subview) => {
    if (subview === 'gate') renderSecurityGate();
    else if (subview === 'log') renderSecurityLog();
    else if (subview === 'passes') renderSecurityPasses();
};

async function saveSecurityPass() {
    const unit_id = document.getElementById('sec-pass-unit')?.value;
    const vehicle_reg = document.getElementById('sec-pass-reg')?.value;
    const hours = parseInt(document.getElementById('sec-pass-hours')?.value, 10) || 4;
    if (!unit_id || !vehicle_reg?.trim()) return alert('Flat and vehicle registration required.');
    const valid_until = new Date(Date.now() + hours * 3600000).toISOString();
    try {
        await createVisitorPass({ unit_id, vehicle_reg, valid_until });
        document.getElementById('sec-pass-form')?.reset();
        renderSecurityPasses();
    } catch (e) {
        alert(e.message);
    }
}

export const initSecurityPortal = () => {
    initGate('sec');
    initGateWizard();

    document.getElementById('sec-log-filters')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-visitor-filter]');
        if (!btn) return;
        const ctx = ensureGateContext('sec');
        ctx.logFilter = btn.dataset.visitorFilter;
        document.querySelectorAll('#sec-log-filters [data-visitor-filter]').forEach((b) => {
            b.classList.toggle('active', b === btn);
        });
        renderSecurityLog();
    });

    document.getElementById('sec-pass-save')?.addEventListener('click', () => void saveSecurityPass());

    document.getElementById('sec-refresh')?.addEventListener('click', async () => {
        await pullState();
        const active = document.querySelector('.security-subview:not([hidden])')?.id?.replace('security-subview-', '') || 'gate';
        renderSecuritySubview(active);
    });

    document.addEventListener('gate-data-updated', () => {
        if (!document.getElementById('view-security')?.classList.contains('active')) return;
        const active = document.querySelector('.security-subview:not([hidden])')?.id?.replace('security-subview-', '') || 'gate';
        renderSecuritySubview(active);
    });

    document.addEventListener('apartment-data-loaded', () => {
        if (document.getElementById('view-security')?.classList.contains('active')) {
            const active = document.querySelector('.security-subview:not([hidden])')?.id?.replace('security-subview-', '') || 'gate';
            renderSecuritySubview(active);
        }
    });

    updateSecClock();
    setInterval(updateSecClock, 30000);
};
