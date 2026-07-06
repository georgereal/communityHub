import { initParkingOps } from '../../parkingOps.js';

let wired = false;

export default async function initParkingFinesView() {
    if (wired) return;
    wired = true;
    initParkingOps();
}
