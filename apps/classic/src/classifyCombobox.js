/** Searchable category / sub-category combobox with known vs custom selection. */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function isExactListMatch(value, options = []) {
    const needle = String(value || '').trim().toLowerCase();
    if (!needle) return null;
    return options.find((o) => String(o).trim().toLowerCase() === needle) || null;
}

export function filterListOptions(query, options = []) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [...options];
    return options.filter((o) => String(o).toLowerCase().includes(q));
}

export function setClassifyInputState(input, state) {
    if (!input) return;
    if (state) input.dataset.classifyState = state;
    else delete input.dataset.classifyState;
}

export function isKnownClassifyInput(input) {
    return input?.dataset.classifyState === 'known';
}

export function isCustomClassifyInput(input) {
    return input?.dataset.classifyState === 'custom';
}

/**
 * @param {HTMLElement} wrap - .bank-recon-classify-combobox container
 * @param {{
 *   getOptions?: () => string[],
 *   onKnownSelect?: (value: string) => void,
 *   onCustomSelect?: (value: string) => void,
 *   onStateChange?: () => void,
 * }} opts
 */
export function wireClassifyCombobox(wrap, {
    getOptions = () => [],
    onKnownSelect,
    onCustomSelect,
    onStateChange,
} = {}) {
    const input = wrap?.querySelector('input');
    const menu = wrap?.querySelector('.bank-recon-classify-combobox__menu');
    if (!input || !menu) return;

    const closeMenu = () => { menu.hidden = true; };

    const pickValue = (value, { custom = false } = {}) => {
        input.value = value;
        if (custom) {
            // Let the page register the value into shared option lists, then treat as known
            // so dropdowns reload and auto-save / auto-post can run (same as Bills).
            onCustomSelect?.(value);
            setClassifyInputState(input, 'known');
            onKnownSelect?.(value);
        } else {
            setClassifyInputState(input, 'known');
            onKnownSelect?.(value);
        }
        closeMenu();
        onStateChange?.();
    };

    const renderMenu = () => {
        const options = getOptions();
        const query = input.value;
        const filtered = filterListOptions(query, options);
        const exact = isExactListMatch(query, options);
        const trimmed = String(query || '').trim();

        let html = filtered.slice(0, 14).map((o) =>
            `<li><button type="button" class="bank-recon-classify-combobox__option" data-value="${esc(o)}">${esc(o)}</button></li>`,
        ).join('');

        if (trimmed && !exact) {
            html += `<li><button type="button" class="bank-recon-classify-combobox__option bank-recon-classify-combobox__option--add" data-value="${esc(trimmed)}" data-custom="1">+ Add "${esc(trimmed)}"</button></li>`;
        }

        menu.innerHTML = html;
        menu.hidden = !html;
    };

    input.addEventListener('focus', renderMenu);
    input.addEventListener('input', () => {
        setClassifyInputState(input, '');
        renderMenu();
        onStateChange?.();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
        if (e.key === 'Enter') {
            e.preventDefault();
            const options = getOptions();
            const exact = isExactListMatch(input.value, options);
            if (exact) pickValue(exact, { custom: false });
            else {
                const trimmed = String(input.value || '').trim();
                if (trimmed) pickValue(trimmed, { custom: true });
                else closeMenu();
            }
        }
    });
    input.addEventListener('blur', () => {
        window.setTimeout(() => {
            if (!wrap.contains(document.activeElement)) closeMenu();
            const options = getOptions();
            const exact = isExactListMatch(input.value, options);
            if (exact && input.dataset.classifyState !== 'known') {
                pickValue(exact, { custom: false });
            } else {
                onStateChange?.();
            }
        }, 120);
    });

    menu.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const btn = e.target.closest('[data-value]');
        if (!btn) return;
        pickValue(btn.dataset.value, { custom: btn.dataset.custom === '1' });
    });
}
