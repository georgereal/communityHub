import { parseRestError, supabasePublicEnv } from './supabaseRest.js';
import { prepareImportedStatementLines } from '../src/bankStatementOrdering.js';
import { extractOcrRowIndexFromTxn } from '../src/bankStatementLineUtils.js';

export const PASSBOOK_JOB_STATUS = {
    INITIALIZED: 'INITIALIZED',
    SUBMITTED: 'SUBMITTED',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    IMPORTED: 'IMPORTED',
};

export function sanitizePassbookJob(job) {
    if (!job || typeof job !== 'object') return job;
    const { callback_token, ...safe } = job;
    return safe;
}

const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
]);

const MONTHS_SHORT = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const monthMatch = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2}|\d{4})$/);
    if (monthMatch) {
        const [, day, mon, year] = monthMatch;
        const monthIndex = MONTHS_SHORT[mon.toLowerCase()];
        if (monthIndex == null) return null;
        const fullYear = year.length === 2 ? `20${year}` : year;
        const dt = new Date(Date.UTC(parseInt(fullYear, 10), monthIndex, parseInt(day, 10)));
        if (Number.isNaN(dt.getTime())) return null;
        return dt.toISOString().slice(0, 10);
    }
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
}

function parseAmount(val) {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
}

function collectRawTransactions(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.account_statement?.transactions)) return data.account_statement.transactions;
    // Evolyx returns the same rows in both `transactions` and `accounts[].transactions`.
    // Prefer the flat list (matches summary.totalTransactions); only fall back to accounts.
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
            const drCr = String(
                txn.type
                || txn.transaction_type
                || txn.drCr
                || txn.dr_cr
                || txn.debitCredit
                || txn.transactionType
                || '',
            ).toUpperCase();
            if (drCr.includes('CR') || drCr.includes('CREDIT') || drCr === 'C' || drCr === 'DEPOSIT') credit = amt;
            else debit = amt;
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

export function validatePassbookFiles(files) {
    if (!Array.isArray(files) || !files.length) {
        throw Object.assign(new Error('At least one passbook file is required.'), { status: 400 });
    }
    if (files.length > 20) throw Object.assign(new Error('Maximum 20 files per request.'), { status: 400 });
    let total = 0;
    for (const file of files) {
        const name = String(file?.name || 'passbook').trim() || 'passbook';
        const mimeType = String(file?.mimeType || '').toLowerCase();
        const base64 = String(file?.base64 || '');
        if (!ALLOWED_MIME.has(mimeType)) {
            throw Object.assign(new Error(`Unsupported file type for ${name}. Use PDF, JPEG, PNG, or WebP.`), { status: 400 });
        }
        if (!base64) throw Object.assign(new Error(`Missing file content for ${name}.`), { status: 400 });
        const bytes = Buffer.byteLength(base64, 'base64');
        if (bytes > 10 * 1024 * 1024) throw Object.assign(new Error(`${name} exceeds 10 MB.`), { status: 400 });
        total += bytes;
    }
    if (total > 50 * 1024 * 1024) throw Object.assign(new Error('Total upload exceeds 50 MB.'), { status: 400 });
    return {
        fileCount: files.length,
        totalBytes: total,
        fileNames: files.map((file) => String(file?.name || 'passbook')),
    };
}

export function summarizeFiles(files = []) {
    return (files || []).map((file) => ({
        name: String(file?.name || 'passbook'),
        mimeType: String(file?.mimeType || ''),
        bytes: file?.base64 ? Buffer.byteLength(String(file.base64), 'base64') : 0,
    }));
}

export async function createPassbookJob(service, { apartmentId, userId, config, requestId, files }) {
    const stats = validatePassbookFiles(files);
    const row = {
        id: crypto.randomUUID(),
        apartment_id: apartmentId,
        provider: 'EVOLYX',
        status: PASSBOOK_JOB_STATUS.INITIALIZED,
        workflow_id: config.workflowId,
        request_id: requestId,
        created_by: userId || null,
        callback_token: crypto.randomUUID(),
        file_count: stats.fileCount,
        total_bytes: stats.totalBytes,
        file_names: stats.fileNames,
    };
    const { data, error } = await service
        .from('passbook_ocr_jobs')
        .insert(row)
        .select('id, apartment_id, provider, status, workflow_id, request_id, execution_id, callback_token, file_count, total_bytes, file_names, mapped_line_count, import_count, imported_at, completed_at, last_error, created_at, updated_at')
        .single();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data;
}

export async function updatePassbookJob(service, jobId, patch) {
    const { data, error } = await service
        .from('passbook_ocr_jobs')
        .update(patch)
        .eq('id', jobId)
        .select('id, apartment_id, provider, status, workflow_id, request_id, execution_id, file_count, total_bytes, file_names, mapped_line_count, import_count, imported_at, completed_at, last_error, created_at, updated_at')
        .single();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data;
}

export async function listPassbookJobs(service, apartmentId, limit = 30) {
    const { data, error } = await service
        .from('passbook_ocr_jobs')
        .select('id, apartment_id, provider, status, workflow_id, request_id, execution_id, file_count, total_bytes, file_names, mapped_line_count, import_count, imported_at, completed_at, last_error, created_at, updated_at')
        .eq('apartment_id', apartmentId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data || [];
}

export async function getPassbookJob(service, apartmentId, jobId) {
    const { data, error } = await service
        .from('passbook_ocr_jobs')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', jobId)
        .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data || null;
}

export async function completePassbookJobByWebhook({ jobId, callbackToken, payload }) {
    const { supabaseUrl, supabaseAnonKey } = supabasePublicEnv();
    const body = {
        p_job_id: jobId,
        p_callback_token: callbackToken,
        p_status: payload.status,
        p_execution_id: payload.execution_id || null,
        p_request_id: payload.request_id || null,
        p_provider_response: payload.provider_response || {},
        p_last_error: payload.last_error || null,
        p_last_error_detail: payload.last_error_detail || null,
        p_mapped_lines: payload.mapped_lines || [],
        p_mapped_line_count: payload.mapped_line_count || 0,
    };
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/complete_passbook_ocr_job`, {
        method: 'POST',
        headers: {
            apikey: supabaseAnonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw Object.assign(new Error(parseRestError(text)), { status: 500 });
    }
    return text ? JSON.parse(text) : null;
}
