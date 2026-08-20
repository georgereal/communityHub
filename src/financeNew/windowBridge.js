/**
 * Route window.* finance hooks to classic vs Finance-New based on active view.
 * Uses a setter trap so classic `window.delTxn = …` does not wipe Finance-New dispatch.
 */
const classic = {};
const financeNew = {};
const installed = new Set();

function isFinanceNewActive() {
    // Finance MPA (/finance/*.html) always uses Finance-New handlers
    if (document.documentElement.dataset.financeApp === '1') return true;
    const accounts = document.getElementById('view-finance-new-accounts');
    const invoices = document.getElementById('view-finance-new-invoices');
    if (accounts?.classList.contains('active') || invoices?.classList.contains('active')) return true;
    // Fallback: hash route (class may lag one tick during switchView)
    const hash = String(window.location.hash || '').replace(/^#/, '');
    return hash.startsWith('fn-');
}

function installDispatch(name) {
    if (installed.has(name)) return;
    installed.add(name);

    const existing = window[name];
    if (typeof existing === 'function' && !existing.__fnDispatch) {
        classic[name] = existing;
    }

    const dispatch = (...args) => {
        if (isFinanceNewActive() && typeof financeNew[name] === 'function') {
            return financeNew[name](...args);
        }
        if (typeof classic[name] === 'function') return classic[name](...args);
        return undefined;
    };
    dispatch.__fnDispatch = true;

    try {
        Object.defineProperty(window, name, {
            configurable: true,
            enumerable: true,
            get() {
                return dispatch;
            },
            set(fn) {
                if (!fn || fn.__fnDispatch) return;
                // Assignments from classic (or others) land here.
                classic[name] = fn;
            },
        });
    } catch {
        window[name] = dispatch;
    }
}

export function bindFinanceNewWindow(name, fn) {
    financeNew[name] = fn;
    installDispatch(name);
}

export function registerClassicWindowHandler(name, fn) {
    classic[name] = fn;
    installDispatch(name);
}
