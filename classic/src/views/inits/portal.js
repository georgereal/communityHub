import { initResidentPortal } from '../../residentPortal.js';

let wired = false;

export default async function initPortalView() {
    if (wired) return;
    wired = true;
    initResidentPortal();
}
