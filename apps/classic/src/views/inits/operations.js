import { initOperations } from '../../operations.js';
import { initNotices } from '../../notices.js';

let wired = false;

export default async function initOperationsView() {
    if (wired) return;
    wired = true;
    initOperations();
    initNotices();
}
