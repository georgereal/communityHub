/**
 * Evolyx passbook OCR — client calls /api/passbook-parse, maps to bank statement lines.
 */
import { portalState, isPlaceholderApartmentId } from './store.js';
import { readApiJson } from './apiJson.js';
import { prepareImportedStatementLines } from './bankStatementOrdering.js';
import { extractOcrRowIndexFromTxn } from './bankStatementLineUtils.js';

export const PASSBOOK_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
export const PASSBOOK_MAX_FILES = 20;
export const PASSBOOK_MAX_BYTES = 10 * 1024 * 1024;

const parseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
};

const parseAmount = (val) => {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
};

const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = String(dataUrl).split(',')[1] || '';
        resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
});

export function validatePassbookFiles(fileList) {
    const files = [...fileList];
    if (!files.length) throw new Error('Select at least one passbook page or PDF.');
    if (files.length > PASSBOOK_MAX_FILES) {
        throw new Error(`Maximum ${PASSBOOK_MAX_FILES} files per upload.`);
    }
    let total = 0;
    for (const file of files) {
        if (file.size > PASSBOOK_MAX_BYTES) {
            throw new Error(`${file.name} exceeds 10 MB.`);
        }
        total += file.size;
        const mime = (file.type || '').toLowerCase();
        const ok = mime === 'application/pdf'
            || mime === 'image/jpeg'
            || mime === 'image/png'
            || mime === 'image/webp';
        if (!ok) {
            throw new Error(`${file.name}: use PDF, JPEG, PNG, or WebP.`);
        }
    }
    if (total > 50 * 1024 * 1024) {
        throw new Error('Total upload exceeds 50 MB.');
    }
    return files;
}

async function filesToPayload(files) {
    const payload = [];
    for (const file of files) {
        payload.push({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64: await readFileAsBase64(file),
        });
    }
    return payload;
}

function collectRawTransactions(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.account_statement?.transactions)) return data.account_statement.transactions;
    if (Array.isArray(data.transactions) && data.transactions.length) return data.transactions;
    const out = [];
    if (Array.isArray(data.accounts)) {
        for (const acct of data.accounts) {
            if (Array.isArray(acct?.transactions)) out.push(...acct.transactions);
        }
    }
    return out;
}

export function mapEvolyxTransactionsToStatementLines(data, openingConfig = {}) {
    const raw = collectRawTransactions(data);
    const lines = [];

    for (let sourceIndex = 0; sourceIndex < raw.length; sourceIndex += 1) {
        const txn = raw[sourceIndex];
        if (!txn || typeof txn !== 'object') continue;
        const lineDate = parseDate(
            txn.line_date
            || txn.date
            || txn.transactionDate
            || txn.transaction_date
            || txn.txnDate
            || txn.txn_date
            || txn.valueDate
            || txn.value_date
            || txn.postingDate,
        );
        if (!lineDate) continue;

        const description = String(
            txn.description
            || txn.narration
            || txn.particulars
            || txn.remarks
            || txn.details
            || txn.reference
            || '',
        ).trim();

        let debit = parseAmount(txn.debit ?? txn.withdrawal ?? txn.withdraw ?? txn.dr);
        let credit = parseAmount(txn.credit ?? txn.deposit ?? txn.cr);

        if (debit <= 0.001 && credit <= 0.001 && txn.amount != null) {
            const amt = parseAmount(txn.amount);
            const drCr = String(txn.type || txn.drCr || txn.dr_cr || txn.debitCredit || txn.transactionType || '').toUpperCase();
            if (drCr.includes('CR') || drCr.includes('CREDIT') || drCr === 'C' || drCr === 'DEPOSIT') {
                credit = amt;
            } else {
                debit = amt;
            }
        }

        if (debit <= 0.001 && credit <= 0.001) continue;

        lines.push({
            line_date: lineDate,
            description: description || null,
            debit,
            credit,
            balance: txn.balance != null ? parseAmount(txn.balance) : null,
            source_row_index: extractOcrRowIndexFromTxn(txn, sourceIndex),
        });
    }

    return prepareImportedStatementLines(lines, openingConfig);
}

export async function parsePassbookFiles(files, { requestId } = {}) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id || isPlaceholderApartmentId(apartment_id)) {
        throw new Error('No society selected. Choose your society from the header and try again.');
    }

    const filePayload = await filesToPayload(files);
    const res = await fetch('/api/passbook-parse', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            apartment_id,
            files: filePayload,
            requestId: requestId || crypto.randomUUID(),
        }),
    });

    const { ok, json, error } = await readApiJson(res);
    if (!ok) {
        if (res.status === 404 && /NOT_FOUND/i.test(error || '')) {
            throw new Error(
                'Passbook API route not found. Deploy the latest CommunityHub build to Vercel, then restart `npm run dev` if testing locally.',
            );
        }
        const detail = json.detail ? `\n\nDetail: ${json.detail}` : '';
        const targetUrl = json.targetUrl ? `\nTarget: ${json.targetUrl}` : '';
        throw new Error((json.error || error || `Passbook parse failed (${res.status}).`) + detail + targetUrl);
    }

    return {
        job: json.job || null,
        executionId: json.executionId || null,
        requestId: json.requestId || null,
        status: json.status || null,
    };
}

export function passbookImportLabel(files, meta) {
    const names = files.map((f) => f.name).join(', ');
    const exec = meta?.executionId ? ` · ${meta.executionId}` : '';
    return `evolyx-passbook:${names}${exec}`;
}

export async function fetchPassbookJobs(apartmentId, jobId = null) {
    const params = new URLSearchParams({ apartment_id: apartmentId });
    if (jobId) params.set('job_id', jobId);
    const res = await fetch(`/api/passbook-jobs?${params.toString()}`);
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || `Could not load passbook jobs (${res.status}).`);
    return jobId ? json.job || null : (json.jobs || []);
}

export async function markPassbookJobImported(apartmentId, jobId, importInfo = {}) {
    const res = await fetch('/api/passbook-jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            apartment_id: apartmentId,
            action: 'mark_imported',
            job_id: jobId,
            import_count: importInfo.importCount || 0,
            imported_statement_import_id: importInfo.importId || null,
        }),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || `Could not update passbook job (${res.status}).`);
    return json.job || null;
}

export function passbookJobImportLabel(job) {
    const names = Array.isArray(job?.file_names) ? job.file_names.join(', ') : 'passbook';
    const exec = job?.execution_id ? ` · ${job.execution_id}` : '';
    return `evolyx-passbook:${names}${exec}`;
}
