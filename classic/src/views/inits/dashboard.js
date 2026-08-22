import { initDashboard } from '../../dashboard.js';

let wired = false;

export default async function initDashboardView() {
    if (wired) return;
    wired = true;
    initDashboard();
}
