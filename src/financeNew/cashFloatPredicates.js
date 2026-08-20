/**
 * Cash-float predicates without ExcelJS / cash-float page UI.
 */
import { normalizeCategoryKey } from '../expenseCategories.js';

const txnWallet = (t) => String(t?.wallet || 'CASH').toUpperCase();

/** Bank OUT that funds the petty cash float. */
export const isBankPettyFunding = (t) =>
    t?.type === 'OUT'
    && txnWallet(t) === 'BANK'
    && normalizeCategoryKey(t.cat) === 'Petty Cash'
    && !t.exclude_from_cash_float;

/** Cash-desk spend that draws down the float (real expense categories). */
export const isCashDeskSpend = (t) =>
    t?.type === 'OUT'
    && txnWallet(t) === 'CASH'
    && normalizeCategoryKey(t.cat) !== 'Petty Cash';

/** Optional desk top-ups recorded as Petty Inflow on CASH. */
export const isCashDeskTopUp = (t) =>
    t?.type === 'IN'
    && txnWallet(t) === 'CASH'
    && normalizeCategoryKey(t.cat) === 'Petty Inflow';

export const getCashExpenseReportingMode = () => {
    const el = document.getElementById('fn-fa-cash-expense-reporting');
    const fromDom = el?.dataset?.mode;
    const v = fromDom || localStorage.getItem('fa-cash-expense-reporting') || 'petty_bank';
    return v === 'cash_detail' ? 'cash_detail' : 'petty_bank';
};

export const setCashExpenseReportingMode = (mode) => {
    const v = mode === 'cash_detail' ? 'cash_detail' : 'petty_bank';
    localStorage.setItem('fa-cash-expense-reporting', v);
    const el = document.getElementById('fn-fa-cash-expense-reporting');
    if (!el) return;
    el.dataset.mode = v;
    el.classList.toggle('fa-cash-mode--on', v === 'cash_detail');
    el.querySelectorAll('.fa-cash-mode__side').forEach((side) => {
        side.classList.toggle('fa-cash-mode__side--active', side.dataset.side === v);
    });
    const toggle = el.querySelector('.fa-cash-mode__toggle');
    if (toggle) toggle.setAttribute('aria-checked', v === 'cash_detail' ? 'true' : 'false');
};
