/**
 * Declarative RBAC UI gates for New MPAs (HTML + vanilla JS).
 *
 * Annotate actions with capability ids — same ids as `capabilities.js` / Admin Roles CRUD:
 *
 *   <button data-cap="accounts.edit">Add expense</button>
 *   <button data-cap="accounts.bills_enter">Quick capture</button>
 *   <button data-cap="accounts.docs_manage">Add bill</button>
 *   <button data-cap-any="accounts.edit,setup.edit">…</button>
 *   <button data-cap-all="accounts.view,accounts.bills_enter">…</button>
 *   <input data-cap="setup.edit" data-cap-mode="disable" />
 *
 * After injecting or re-rendering HTML, call `refreshCapabilityGates(container)`.
 * React pages: prefer `<CapGate cap="…">` from `components/CapGate.jsx`.
 */
import { can } from './capabilities.js';

function capIds(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** @param {Element} el */
export function elementCapAllowed(el) {
    const cap = el.getAttribute('data-cap');
    const any = el.getAttribute('data-cap-any');
    const all = el.getAttribute('data-cap-all');
    const not = el.getAttribute('data-cap-not');

    if (not && can(not)) return false;
    if (cap && !can(cap)) return false;

    const anyIds = capIds(any);
    if (anyIds.length && !anyIds.some((id) => can(id))) return false;

    const allIds = capIds(all);
    if (allIds.length && !allIds.every((id) => can(id))) return false;

    return true;
}

/**
 * Show/hide or disable elements annotated with data-cap* under `root`.
 * @param {ParentNode} [root]
 */
export function applyCapabilityGates(root = document) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-cap], [data-cap-any], [data-cap-all], [data-cap-not]').forEach((el) => {
        const allowed = elementCapAllowed(el);
        const mode = el.getAttribute('data-cap-mode') || 'hide';
        if (mode === 'disable') {
            el.disabled = !allowed;
            el.classList.toggle('cap-gate--disabled', !allowed);
            el.setAttribute('aria-disabled', allowed ? 'false' : 'true');
        } else {
            el.hidden = !allowed;
            el.setAttribute('aria-hidden', allowed ? 'false' : 'true');
            el.classList.toggle('cap-gate--hidden', !allowed);
        }
    });
}

/** Alias — call after dynamic list/table renders. */
export const refreshCapabilityGates = applyCapabilityGates;

/** Programmatic check matching data-cap rules (for template strings). */
export function capAllowed({ cap, any, all, not } = {}) {
    const probe = {
        getAttribute(name) {
            if (name === 'data-cap') return cap || null;
            if (name === 'data-cap-any') return any?.join(',') || null;
            if (name === 'data-cap-all') return all?.join(',') || null;
            if (name === 'data-cap-not') return not || null;
            return null;
        },
    };
    return elementCapAllowed(probe);
}
