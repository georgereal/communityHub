/**
 * Consistent loading state for action buttons.
 */
export function setButtonBusy(btn, label = 'Working…') {
    if (!btn || btn.dataset.busy === '1') return null;
    const snapshot = {
        html: btn.innerHTML,
        disabled: btn.disabled,
    };
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.classList.add('btn--busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ${label}`;
    return snapshot;
}

export function clearButtonBusy(btn, snapshot) {
    if (!btn) return;
    btn.dataset.busy = '0';
    btn.classList.remove('btn--busy');
    btn.removeAttribute('aria-busy');
    if (snapshot) {
        btn.innerHTML = snapshot.html;
        btn.disabled = snapshot.disabled;
    }
}

/** Run async work with button busy state; restores on success or error. */
export async function withButtonBusy(btn, label, fn) {
    const snapshot = setButtonBusy(btn, label);
    try {
        return await fn();
    } finally {
        clearButtonBusy(btn, snapshot);
    }
}

/** Wire click → async handler with busy label (skips if already busy). */
export function bindBusyClick(btn, label, handler) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (btn.dataset.busy === '1') return;
        await withButtonBusy(btn, label, () => handler(btn));
    });
}
