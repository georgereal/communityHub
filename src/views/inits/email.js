import { initEmailOutbox } from '../../emailOutbox.js';

let wired = false;

export default async function initEmailView() {
    if (wired) return;
    wired = true;
    initEmailOutbox();
}
