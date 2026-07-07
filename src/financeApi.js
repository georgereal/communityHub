import { portalState } from './store.js';
import { readApiJson } from './apiJson.js';

export async function postFinanceMutation(action, payload = {}) {
    const apartment_id = payload.apartment_id || portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const res = await fetch('/api/finance-mutations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            action,
            apartment_id,
            ...payload,
        }),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Finance request failed.');
    return json;
}

export async function fileToBase64Payload(file) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
    });
    return {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64: String(dataUrl).split(',')[1] || '',
    };
}

export async function filesToBase64Payload(files = []) {
    const out = [];
    for (const file of files) {
        out.push(await fileToBase64Payload(file));
    }
    return out;
}
