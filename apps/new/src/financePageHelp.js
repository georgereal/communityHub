/**
 * Brief blurbs + in-page help for Finance (Income & Expenses + Invoices).
 */

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** @typedef {{ title: string, blurb: string, steps: string[], tips?: string[] }} FinancePageHelp */

/** @type {Record<string, FinancePageHelp>} */
export const ACCOUNTS_PAGE_HELP = {
    ledger: {
        title: 'Ledger',
        blurb: 'Cash and bank passbook for this society — every income and expense line in one place.',
        steps: [
            'Use the tabs under the header to move between Ledger, Bills & receipts, reports, and the other finance tools.',
            'Scan balances in the KPI bar (Total, Petty cash, Bank, Today out).',
            'Filter with search, category, or date range in the toolbar; sort by clicking column headers.',
            'Classify category inline (auto-saves), or use Edit for ledger fields only (amount, date, category, wallet, narration).',
            'Use the invoice button on a row to create, link, or edit a bill/receipt in the Bills & receipts form.',
            'Open linked bills from the Bills column to view them.',
            'Use Bank Sync when you need a quick bank snapshot while working the ledger.',
            'Exclude-from-reports lines stay in the ledger but are listed separately under the main table.',
        ],
        tips: [
            'Cash vs Bank is chosen on each entry — bank lines can carry a payment reference.',
            'Edit ledger ≠ bill/receipt — attachments and payment status live on the invoice button.',
            'Spreadsheet sync (if enabled) appears above the ledger workspace.',
        ],
    },
    'finance-docs': {
        title: 'Bills & receipts',
        blurb: 'Vendor bills and income receipts — track paperwork before or alongside ledger posting.',
        steps: [
            'Use Quick capture for a phone-friendly step flow: type → photo → vendor → amount → payment → review.',
            'Or use Add bill / Add receipt for the full form on desktop.',
            'Use status and search filters to find unpaid, partial, or settled items.',
            'Open a row for details, funding links, and to connect the document to ledger lines when ready.',
            'Bank Sync remains available if you need to cross-check a bank balance while working bills.',
        ],
        tips: [
            'Bills & receipts are the document trail; the Ledger is the society passbook.',
            'Association staff with bills entry can Quick capture without ledger linking tools.',
        ],
    },
    'expense-plan': {
        title: 'Expense plan',
        blurb: 'Planned spends over a horizon versus current book balance — spot shortfalls early.',
        steps: [
            'Pick a horizon (3 / 6 / 12 months) in the toolbar.',
            'Review the by-month pivot and the detail list; expand Recurring templates to manage repeating plans.',
            'Click a row for detail; expand Recurring templates to manage repeating plans.',
            'Add recurring with a term (periods): same amount each time, total split equally, or manual per period.',
            'Add one-off or recurring items when those actions are available for your role.',
        ],
        tips: [
            'Use this with Financial reports to compare plan versus actual category spend.',
            'Total split needs a term length — e.g. ₹1,20,000 over 12 months → ₹10,000 each.',
        ],
    },
    reports: {
        title: 'Financial reports',
        blurb: 'Monthly income/expense pivots, trends, and balance checks for committee reporting.',
        steps: [
            'Set History, Pivot by, Forecast, and Match dates in the toolbar; download Excel when you need a shareable pack.',
            'Toggle Bank Petty Cash vs Cash bills by category to change how cash expenses appear in stacks.',
            'Read balance metrics first, then open the Cash position and Monthly summary panels.',
            'Use Bank reconciliation from the toolbar when statement matching needs attention.',
        ],
        tips: [
            '“Structured expenses only” focuses on sheet and bank-classified lines.',
            'Projection controls forecast forward months from recent trends.',
        ],
    },
    'invoices-raised': {
        title: 'Invoices Raised',
        blurb: 'Invoice data imported from external tools (NoBroker, MyGate, and similar) for financial tracking and reconciliation.',
        steps: [
            'Upload an Excel export from NoBroker, MyGate, or another billing tool to store raised-invoice rows here.',
            'Use this grid to review what was billed externally — amounts, flats, periods — alongside your society books.',
            'Type in the filter row under each column; amount filters support 0, >1000, >=500, <100.',
            'Use Clear filters and the column picker to focus on the fields you need.',
            'For dues raised and collected inside CommunityHub, use the Invoices section in the Finance sidebar.',
        ],
        tips: [
            'This page is a tracking mirror of third-party raised invoices, not a replacement for Maintenance Billing.',
        ],
    },
    'bank-recon': {
        title: 'Bank Reconciliation',
        blurb: 'Import or scan the bank statement, then match lines to ledger entries.',
        steps: [
            'Start with Opening balance if it is not set — reconciliation needs a correct starting point.',
            'Import statement (Excel/CSV) or Passbook scan (PDF/photos) to load statement lines.',
            'Work unmatched lines: classify, match to ledger, or mark as expected differences.',
            'Use Add ledger expense / income from the header when a statement line needs a new ledger entry.',
            'Clear or re-import carefully — duplicates with the same date, description, and amount are skipped.',
        ],
        tips: [
            'Download the import template before pasting a bank export.',
            'Manual rows help when OCR misses overlapping print on a passbook page.',
        ],
    },
    activity: {
        title: 'Activity Log',
        blurb: 'Audit trail of important finance and administration actions for this society.',
        steps: [
            'Scroll the list newest-first; open an entry for actor, time, and change detail.',
            'Use filters when available to narrow by type or date.',
            'Return to Income & Expenses via the Finance sidebar for ledger and billing work.',
        ],
    },
};

/** @type {Record<string, FinancePageHelp>} */
export const INVOICE_PAGE_HELP = {
    'pending-dues': {
        title: 'Pending Dues',
        blurb: 'Flats with an outstanding balance — collect payments and follow up from here.',
        steps: [
            'Scan the KPI cards for outstanding, collected this month, open invoices, and flats with dues.',
            'Search by flat or block; select rows for bulk reminders or Excel export.',
            'Open a flat to see invoices; use Record payment or Raise Invoices from the header when needed.',
            'Configure Charge Heads, Penalty Rules, and Billing Groups before a large raise run.',
        ],
        tips: [
            'Send Invoices and Apply Penalties are header actions for batch follow-up.',
        ],
    },
    list: {
        title: 'All Invoices',
        blurb: 'Every invoice raised — individual, group, and corrections — the billing ledger.',
        steps: [
            'Filter by search text and status (open, paid, void, etc.).',
            'Open a row for line items, payments applied, PDF, and email options.',
            'Use bulk actions when selecting multiple invoices.',
            'Switch to Pending Dues for flat-level balances, or Collections for payment history.',
        ],
    },
    collections: {
        title: 'Collections',
        blurb: 'Maintenance payments recorded and how they were applied to invoices.',
        steps: [
            'Browse collection rows and open one to see allocation across invoices.',
            'Use Record payment for a single flat, or bulk-import from bank / NoBroker statements when available.',
            'Cross-check with Pending Dues after large import runs.',
        ],
    },
    batches: {
        title: 'Billing Batches',
        blurb: 'Bulk raise-invoice runs — what was created, skipped, or failed.',
        steps: [
            'Review each billing run for period, flats covered, and outcomes.',
            'Open a batch for per-flat detail when reconciling a raise.',
            'Raise new invoices from the header when starting the next period.',
        ],
    },
    aging: {
        title: 'Aging Report',
        blurb: 'Overdue balances by age bucket — prioritise reminders and follow-up.',
        steps: [
            'Read buckets (e.g. current vs 30 / 60 / 90+ days) for concentration of dues.',
            'Drill into flats or amounts that need attention, then return to Pending Dues to send reminders.',
            'Apply Penalties from the header when your society rules require late fees.',
        ],
    },
};

/**
 * @param {FinancePageHelp | null | undefined} help
 * @returns {string}
 */
export function renderFinanceHelpBody(help) {
    if (!help) return '<p class="page-help-popover__empty">No help is available for this page yet.</p>';
    const steps = (help.steps || [])
        .map((s) => `<li>${esc(s)}</li>`)
        .join('');
    const tips = (help.tips || []).length
        ? `<div class="page-help-popover__tips"><strong>Tips</strong><ul>${help.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
        : '';
    return `
      <p class="page-help-popover__lead">${esc(help.blurb)}</p>
      <p class="page-help-popover__how">How to navigate</p>
      <ol class="page-help-popover__steps">${steps}</ol>
      ${tips}
    `;
}

/**
 * Wire a help button + popover for a finance page shell.
 * @param {{
 *   btnId: string,
 *   popoverId: string,
 *   getHelp: () => FinancePageHelp | null | undefined,
 * }} opts
 */
export function wireFinancePageHelp(opts) {
    const btn = document.getElementById(opts.btnId);
    const pop = document.getElementById(opts.popoverId);
    if (!btn || !pop || btn.dataset.helpWired === '1') return;
    btn.dataset.helpWired = '1';

    const close = () => {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };

    const open = () => {
        pop.innerHTML = `
          <div class="page-help-popover__head">
            <strong>${esc(opts.getHelp()?.title || 'Help')}</strong>
            <button type="button" class="page-help-popover__close" aria-label="Close help">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
          <div class="page-help-popover__body">${renderFinanceHelpBody(opts.getHelp())}</div>
        `;
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        pop.querySelector('.page-help-popover__close')?.addEventListener('click', close);
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop.hidden) open();
        else close();
    });

    document.addEventListener('click', (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || btn.contains(e.target)) return;
        close();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !pop.hidden) close();
    });
}

/**
 * @param {{ titleId?: string, descId?: string, help: FinancePageHelp | null | undefined }} opts
 */
export function applyFinancePageHeader(opts) {
    const help = opts.help;
    const titleEl = opts.titleId ? document.getElementById(opts.titleId) : null;
    const descEl = opts.descId ? document.getElementById(opts.descId) : null;
    if (titleEl && help?.title) titleEl.textContent = help.title;
    if (descEl) descEl.textContent = help?.blurb || '';
}
