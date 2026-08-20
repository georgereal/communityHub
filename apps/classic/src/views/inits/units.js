import { initUnitDirectory } from '../../unitDirectory.js';

let wired = false;

export default async function initUnitsView() {
    if (wired) return;
    wired = true;
    initUnitDirectory();
}
