/** Finance UI gates — CRUD matrix first; capability names for labels only. */
import { can } from '../capabilities.js';
import { canCrud } from '../rbacMatrix.js';

export const canManageFinanceDocs = () => canCrud('accounts', 'update');
export const canDeleteFinanceDocs = () => canCrud('accounts', 'delete');
export const canEnterFinanceDocs = () =>
    canCrud('accounts', 'create') || can('accounts.bills_enter');
export const canEditLedger = () => canCrud('accounts', 'update');

/** Bills entry without link/edit/delete/import (Office Manager, Office Staff). */
export const isStaffBillsOnly = () =>
    canEnterFinanceDocs() && !canManageFinanceDocs();
