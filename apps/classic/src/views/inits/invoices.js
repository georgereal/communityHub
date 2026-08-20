import { initMaintenanceBilling } from '../../maintenanceBilling.js';
import { initPayments } from '../../payments.js';

let wired = false;

export default async function initInvoicesView() {
    if (wired) return;
    wired = true;
    initMaintenanceBilling();
    initPayments();
}
