/**
 * Evolyx passbook OCR — client calls /api/passbook-parse, maps to bank statement lines.
 */
import { portalState, supabase, isPlaceholderApartmentId } from './store.js';
import { readApiJson } from './apiJson.js';

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
    const out = [];
    if (Array.isArray(data.transactions)) out.push(...data.transactions);
    if (Array.isArray(data.accounts)) {
        for (const acct of data.accounts) {
            if (Array.isArray(acct?.transactions)) out.push(...acct.transactions);
        }
    }
    return out;
}

export function mapEvolyxTransactionsToStatementLines(data) {
    const raw = collectRawTransactions(data);
    const lines = [];

    for (const txn of raw) {
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
        });
    }

    lines.sort((a, b) => a.line_date.localeCompare(b.line_date) || (a.description || '').localeCompare(b.description || ''));
    return lines;
}

export async function parsePassbookFiles(files, { requestId } = {}) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id || isPlaceholderApartmentId(apartment_id)) {
        throw new Error('No society selected. Choose your society from the header and try again.');
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Sign in required.');

    const filePayload = await filesToPayload(files);
    const res = await fetch('/api/passbook-parse', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${session.access_token}`,
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
        throw new Error(json.error || error || `Passbook parse failed (${res.status}).`);
    }

    const lines = mapEvolyxTransactionsToStatementLines(json.data);
    if (!lines.length) {
        const total = json.data?.summary?.totalTransactions;
        throw new Error(
            total
                ? `Evolyx reported ${total} transaction(s) but none could be mapped. Check date/amount fields.`
                : 'No transactions found in passbook. Try clearer photos or a PDF export.',
        );
    }

    return {
        lines,
        meta: {
            executionId: json.executionId,
            requestId: json.requestId,
            durationMs: json.durationMs,
            filesProcessed: json.filesProcessed,
            summary: json.data?.summary,
            accounts: json.data?.accounts,
        },
    };
}

export function passbookImportLabel(files, meta) {
    const names = files.map((f) => f.name).join(', ');
    const exec = meta?.executionId ? ` · ${meta.executionId}` : '';
    return `evolyx-passbook:${names}${exec}`;
}
