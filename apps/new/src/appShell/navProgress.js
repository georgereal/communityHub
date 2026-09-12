/**
 * Route-transition progress: keep the last painted UI and show a spinner overlay
 * (or a full-viewport cover for hard document navigations).
 */
const PENDING_KEY = 'ch_nav_pending';
const OVERLAY_ID = 'ch-nav-progress';

function ensureStyles() {
    if (document.getElementById('ch-nav-progress-style')) return;
    const style = document.createElement('style');
    style.id = 'ch-nav-progress-style';
    style.textContent = `
      html.ch-nav-busy { cursor: progress; }
      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 100000;
        display: flex; align-items: center; justify-content: center;
        pointer-events: all;
        background: rgba(248, 250, 252, 0.72);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        opacity: 0;
        animation: ch-nav-fade-in 140ms ease-out forwards;
      }
      #${OVERLAY_ID}.ch-nav-progress--cover {
        background: #f4f6f9;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      #${OVERLAY_ID} .ch-nav-progress__card {
        display: flex; flex-direction: column; align-items: center; gap: 0.85rem;
        padding: 1.25rem 1.5rem;
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
        border: 1px solid rgba(15, 23, 42, 0.06);
      }
      #${OVERLAY_ID}.ch-nav-progress--cover .ch-nav-progress__card {
        box-shadow: none;
        border: none;
        background: transparent;
        padding: 0;
      }
      #${OVERLAY_ID} .ch-nav-progress__spinner {
        width: 34px; height: 34px;
        border-radius: 50%;
        border: 3px solid #dbe3ee;
        border-top-color: #2563eb;
        animation: ch-nav-spin 0.7s linear infinite;
      }
      #${OVERLAY_ID} .ch-nav-progress__label {
        margin: 0;
        font: 500 0.875rem/1.3 Inter, system-ui, sans-serif;
        color: #475569;
        letter-spacing: 0.01em;
      }
      @keyframes ch-nav-spin { to { transform: rotate(360deg); } }
      @keyframes ch-nav-fade-in { to { opacity: 1; } }
    `;
    document.head.appendChild(style);
}

export function markHardNavPending() {
    try {
        sessionStorage.setItem(PENDING_KEY, '1');
    } catch { /* ignore */ }
}

export function clearHardNavPending() {
    try {
        sessionStorage.removeItem(PENDING_KEY);
    } catch { /* ignore */ }
}

export function showNavProgress({ label = 'Loading', cover = false } = {}) {
    ensureStyles();
    document.documentElement.classList.add('ch-nav-busy');
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = OVERLAY_ID;
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-busy', 'true');
        el.innerHTML = `
          <div class="ch-nav-progress__card">
            <div class="ch-nav-progress__spinner" aria-hidden="true"></div>
            <p class="ch-nav-progress__label"></p>
          </div>`;
        document.body.appendChild(el);
    }
    el.classList.toggle('ch-nav-progress--cover', !!cover);
    const labelEl = el.querySelector('.ch-nav-progress__label');
    if (labelEl) labelEl.textContent = label;
    return el;
}

export function hideNavProgress() {
    clearHardNavPending();
    document.documentElement.classList.remove('ch-nav-busy');
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById('ch-boot-splash')?.remove();
}

/** Paint overlay, then full document navigation (keeps transition feeling continuous). */
export function beginHardNavigation(href) {
    showNavProgress({ cover: true, label: 'Loading' });
    markHardNavPending();
    const go = () => {
        window.location.assign(href);
    };
    // Let the overlay paint before unload.
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(go));
    } else {
        setTimeout(go, 16);
    }
}

/** Soft in-app route change: dim current page, clear shortly after paint. */
export function beginSoftNavigation() {
    showNavProgress({ cover: false, label: 'Loading' });
}

export function endSoftNavigation() {
    // Allow React route + first paint to settle.
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => hideNavProgress());
        });
    } else {
        setTimeout(hideNavProgress, 50);
    }
}

/** Call once on every MPA entry (module top-level). */
export function installNavProgressBoot() {
    if (typeof window === 'undefined' || window.__chNavProgressBooted) return;
    window.__chNavProgressBooted = true;
    try {
        if (sessionStorage.getItem(PENDING_KEY) === '1') {
            showNavProgress({ cover: true, label: 'Loading' });
        }
    } catch { /* ignore */ }

    window.addEventListener('ch-mpa-inapp-nav', () => {
        beginSoftNavigation();
    });
}

installNavProgressBoot();
