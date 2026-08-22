/**
 * Society Profile accordion: collapse/expand, attention badges, summary strip.
 */
import { portalState } from './store.js';

const OPEN_KEY = 'communityhub_setup_society_open';

/** @type {Map<string, { count: number, label: string, tone?: string }>} */
const attentionBySection = new Map();

function stack() {
    return document.getElementById('setup-subview-society');
}

function sectionEl(id) {
    return stack()?.querySelector(`[data-setup-acc="${id}"]`);
}

function readOpenSet() {
    try {
        const raw = sessionStorage.getItem(OPEN_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function writeOpenSet(set) {
    try {
        sessionStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
    } catch {
        /* ignore */
    }
}

export function isSetupSectionOpen(id) {
    const el = sectionEl(id);
    return el?.classList.contains('is-open') ?? false;
}

export function setSetupSectionOpen(id, open) {
    const el = sectionEl(id);
    if (!el) return;
    const trigger = el.querySelector('.setup-acc__trigger');
    const panel = el.querySelector('.setup-acc__panel');
    el.classList.toggle('is-open', open);
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (panel) panel.hidden = !open;

    const openSet = readOpenSet();
    if (open) openSet.add(id);
    else openSet.delete(id);
    writeOpenSet(openSet);
}

export function openSetupSection(id, { scroll = true } = {}) {
    setSetupSectionOpen(id, true);
    const el = sectionEl(id);
    if (scroll && el) {
        requestAnimationFrame(() => {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }
}

export function setSetupSectionStat(id, text) {
    const el = sectionEl(id)?.querySelector('[data-acc-stat]');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
}

/**
 * @param {string} id
 * @param {{ count?: number, label?: string, tone?: 'alert' | 'warn' | 'info' } | null} attention
 */
export function setSetupSectionAttention(id, attention) {
    if (!attention || !attention.count) {
        attentionBySection.delete(id);
    } else {
        attentionBySection.set(id, {
            count: attention.count,
            label: attention.label || `${attention.count} pending`,
            tone: attention.tone || 'alert',
        });
    }
    paintSectionAttention(id);
    paintAttentionBanner();
}

function paintSectionAttention(id) {
    const section = sectionEl(id);
    if (!section) return;
    const badge = section.querySelector('[data-acc-badge]');
    const info = attentionBySection.get(id);
    section.classList.toggle('has-attention', Boolean(info));
    if (!badge) return;
    if (!info) {
        badge.hidden = true;
        badge.textContent = '';
        badge.className = 'setup-acc__badge';
        return;
    }
    badge.hidden = false;
    badge.textContent = info.label;
    badge.className = `setup-acc__badge setup-acc__badge--${info.tone || 'alert'}`;
}

function paintAttentionBanner() {
    const banner = document.getElementById('setup-attention');
    const textEl = document.getElementById('setup-attention-text');
    const chipsEl = document.getElementById('setup-attention-chips');
    if (!banner || !chipsEl) return;

    const items = [...attentionBySection.entries()]
        .filter(([, v]) => v.count > 0)
        .map(([id, v]) => ({ id, ...v }));

    if (!items.length) {
        banner.hidden = true;
        chipsEl.replaceChildren();
        return;
    }

    banner.hidden = false;
    const total = items.reduce((sum, i) => sum + i.count, 0);
    if (textEl) {
        textEl.textContent = total === 1
            ? '1 item needs your attention'
            : `${total} items need your attention`;
    }

    const labels = {
        people: 'Access requests',
        portal: 'Portal invites',
        identity: 'Society profile',
        modules: 'Modules',
        portfolio: 'Societies',
    };

    chipsEl.innerHTML = items.map((item) => `
      <button type="button" class="setup-attention__chip setup-attention__chip--${item.tone || 'alert'}" data-jump-acc="${item.id}">
        <span class="setup-attention__chip-count">${item.count}</span>
        ${labels[item.id] || item.label}
      </button>
    `).join('');

    chipsEl.querySelectorAll('[data-jump-acc]').forEach((btn) => {
        btn.addEventListener('click', () => openSetupSection(btn.dataset.jumpAcc));
    });
}

export function refreshSetupSocietyMeta() {
    const name = portalState.community?.name
        || portalState.access?.apartments?.find((a) => a.id === portalState.access?.activeApartmentId)?.name
        || '';
    const cars = portalState.community?.defaults?.cars;
    const bikes = portalState.community?.defaults?.bikes;
    const subtitle = document.getElementById('setup-page-subtitle');
    if (subtitle) {
        subtitle.textContent = name
            ? `Settings for ${name}`
            : 'Identity, access, and portal settings for this society';
    }

    const parts = [];
    if (name) parts.push(name);
    if (cars != null && bikes != null) parts.push(`${cars} car · ${bikes} bike default`);
    setSetupSectionStat('identity', parts.join(' · ') || 'Not configured');

    if (!name?.trim()) {
        setSetupSectionAttention('identity', { count: 1, label: 'Name needed', tone: 'warn' });
    } else {
        setSetupSectionAttention('identity', null);
    }

    const activeId = portalState.access?.activeApartmentId;
    const users = (portalState.access?.users || []).filter((u) => {
        if (!activeId) return true;
        return (u.apartment_ids || []).includes(activeId);
    });
    const unassigned = (portalState.access?.users || []).filter((u) => {
        if (!activeId) return false;
        return !(u.apartment_ids || []).includes(activeId);
    }).length;

    setSetupSectionStat('people', users.length
        ? `${users.length} user${users.length === 1 ? '' : 's'}`
        : 'No users yet');

    // Unassigned is informational, not blocking — only surface if viewing with show-unassigned off and none linked
    if (!users.length && unassigned > 0 && !attentionBySection.get('people')?.count) {
        setSetupSectionStat('people', `0 linked · ${unassigned} unassigned`);
    }

    const links = portalState.portal?.residentLinks || [];
    const invites = (portalState.portal?.portalInvites || []).filter((i) => i.status === 'PENDING');
    setSetupSectionStat('portal', [
        links.length ? `${links.length} linked` : 'No links',
        invites.length ? `${invites.length} invite${invites.length === 1 ? '' : 's'} pending` : null,
    ].filter(Boolean).join(' · '));
}

/**
 * @param {string} id
 * @param {number} count
 * @param {string} [label]
 */
export function setPendingAccessAttention(count, label) {
    setSetupSectionAttention('people', count > 0
        ? { count, label: label || `${count} pending`, tone: 'alert' }
        : null);
    refreshSetupSocietyMeta();
}

export function setPendingInviteAttention(count) {
    setSetupSectionAttention('portal', count > 0
        ? { count, label: `${count} invite${count === 1 ? '' : 's'}`, tone: 'warn' }
        : null);
    refreshSetupSocietyMeta();
}

export function initSetupSocietyAccordion() {
    const root = stack();
    if (!root || root.dataset.accWired === '1') {
        refreshSetupSocietyMeta();
        return;
    }
    root.dataset.accWired = '1';

    const openSet = readOpenSet();
    root.querySelectorAll('[data-setup-acc]').forEach((section) => {
        const id = section.dataset.setupAcc;
        const trigger = section.querySelector('.setup-acc__trigger');
        if (!trigger) return;

        // Default collapsed; restore only if user opened in this session
        setSetupSectionOpen(id, openSet.has(id));

        trigger.addEventListener('click', (e) => {
            // Don't toggle when clicking nested action buttons placed in toolbar (not in trigger)
            if (e.target.closest('a, button:not(.setup-acc__trigger)')) return;
            setSetupSectionOpen(id, !section.classList.contains('is-open'));
        });
    });

    document.getElementById('setup-expand-attention')?.addEventListener('click', () => {
        [...attentionBySection.keys()].forEach((id) => openSetupSection(id, { scroll: false }));
        const first = [...attentionBySection.keys()][0];
        if (first) openSetupSection(first);
    });

    refreshSetupSocietyMeta();
}
