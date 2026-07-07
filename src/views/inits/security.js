import { initSecurityPortal } from '../../securityPortal.js';

let wired = false;

export default async function initSecurityView() {
    if (wired) return;
    wired = true;
    initSecurityPortal();
}
