import { requireApartmentPermission, requireAnyApartmentPermission } from './serverAuth.js';
import { prepareImportedStatementLines, computeRunningBalances } from '../src/bankStatementOrdering.js';
import { inferExpenseCategory, BANK_REJECT_CAT } from '../src/expenseCategories.js';
import { findMatchingRule } from '../src/bankClassificationRules.js';
import {
    isR2Configured,
    r2PutObject,
    r2DeleteObjects,
    buildFinanceDocObjectKey,
    extForRecordMime,
    attachmentObjectKey,
    isAllowedFinanceDocObjectKey,
} from './r2Storage.js';

const RECEIPT_BUCKET = 'transaction-receipts';

/** unpaid → paid → linked (void cancelled). Legacy "open" maps via payment notes. */
const paymentLooksPaid = (notes) => {
    const text = String(notes || '').trim();
    return /^Cheque:\s*.+/i.test(text)
        || /^Online:\s*.+/i.test(text)
        || /Payment:\s*Cash/i.test(text)
        || /Payment:\s*Online/i.test(text)
        || /^cash$/i.test(text);
};

const resolveFinanceDocStatus = (doc = {}, transactionId = null) => {
    const raw = String(doc.status || '').toLowerCase();
    if (raw === 'void') return 'void';
    if (transactionId || raw === 'linked') return 'linked';
    if (raw === 'unpaid' || raw === 'paid') return raw;
    // Legacy open / missing: derive from notes
    return paymentLooksPaid(doc.notes) ? 'paid' : 'unpaid';
};

const roundMoney = (n) => Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100;
const bankLineAmount = (line) => Math.max(parseFloat(line?.credit || 0), parseFloat(line?.debit || 0), 0);
const bankLineType = (line) => parseFloat(line?.credit || 0) > 0.001 ? 'IN' : 'OUT';
const inferIncomeCategory = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/REJECT|RETURNED|BOUNCE|DISHONOU?R|CHQ\s*RET|CHEQUE\s*RET|INWARD\s*RET/.test(u)) return BANK_REJECT_CAT;
    if (/INTEREST|\bINT\b/.test(u)) return 'Interest';
    if (/NOBROKER|MAINT|RENT|COLLECT|FLAT/.test(u)) return 'Maintenance Collection';
    return 'Other Income';
};
const inferBankPaymentType = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/UPI|GPAY|PHONEPE|PAYTM/.test(u)) return 'UPI';
    if (/NEFT|IMPS|RTGS/.test(u)) return 'NEFT';
    if (/CHQ|CHEQUE/.test(u)) return 'CHEQUE';
    return 'NEFT';
};
const statementReference = (lineId) => `STMT-${String(lineId || '').slice(0, 8)}`;
const matchFlatFromText = (text, units = []) => {
    const src = String(text || '').toUpperCase();
    for (const unit of units) {
        const num = String(unit?.number || '').trim();
        if (!num) continue;
        if (src.includes(num.toUpperCase())) return num;
    }
    return null;
};

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body || '{}');
        } catch {
            return {};
        }
    }
    return req.body;
}

async function maybeDeletePaths(service, paths = []) {
    if (!paths.length) return;
    await service.storage.from(RECEIPT_BUCKET).remove(paths);
}

async function maybeDeleteAttachmentEntries(service, entries = []) {
    if (!entries.length) return;
    const r2Keys = [];
    const supabasePaths = [];
    for (const entry of entries) {
        const key = attachmentObjectKey(entry);
        if (key && isAllowedFinanceDocObjectKey(key)) {
            r2Keys.push(key);
        } else if (typeof entry === 'string' && entry.startsWith('r2:') && key) {
            r2Keys.push(key);
        } else if (typeof entry === 'string' && entry) {
            supabasePaths.push(entry);
        }
    }
    if (r2Keys.length && isR2Configured()) await r2DeleteObjects(r2Keys);
    if (supabasePaths.length) await maybeDeletePaths(service, supabasePaths);
}

/** Upload finance-doc files to private R2; returns attachment metadata objects (notebook-style). */
async function uploadFinanceDocFilesToR2(apartmentId, files = [], { orgName, kind } = {}) {
    if (!files.length) return [];
    if (!isR2Configured()) {
        throw Object.assign(
            new Error(
                'Object storage is not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET or R2_BUCKET_NAME).',
            ),
            { status: 503 },
        );
    }
    const uploaded = [];
    for (const file of files) {
        const mime = String(file.mimeType || 'application/octet-stream').toLowerCase();
        const ext = extForRecordMime(mime);
        if (!ext) {
            throw Object.assign(
                new Error('Only images (JPEG, PNG, WebP, GIF) or PDF files are supported for document attachments.'),
                { status: 400 },
            );
        }
        const body = Buffer.from(String(file.base64 || ''), 'base64');
        const key = buildFinanceDocObjectKey({
            orgName: orgName || apartmentId,
            kind: kind === 'IN' ? 'IN' : 'OUT',
            mimeOrExt: mime,
        });
        await r2PutObject({ key, body, contentType: mime });
        const purpose = String(file.purpose || '').toLowerCase() === 'payment' ? 'payment' : 'bill';
        uploaded.push({
            key,
            contentType: mime,
            originalName: String(file.name || '').slice(0, 512),
            bytes: body.length,
            uploadedAt: new Date().toISOString(),
            purpose,
        });
    }
    return uploaded;
}

async function resolveApartmentOrgName(service, apartmentId) {
    const { data: apt } = await service
        .from('apartments')
        .select('name')
        .eq('id', apartmentId)
        .maybeSingle();
    if (apt?.name?.trim()) return apt.name.trim();

    const { data: cfg } = await service
        .from('society_config')
        .select('name')
        .eq('apartment_id', apartmentId)
        .maybeSingle();
    if (cfg?.name?.trim()) return cfg.name.trim();

    return apartmentId;
}

function normalizeKeptAttachments(kept = []) {
    return kept
        .map((entry) => {
            if (entry && typeof entry === 'object' && entry.key) {
                const key = String(entry.key).trim();
                if (!isAllowedFinanceDocObjectKey(key)) return null;
                const purpose = String(entry.purpose || '').toLowerCase() === 'payment' ? 'payment' : 'bill';
                return {
                    key,
                    contentType: String(entry.contentType || 'application/octet-stream'),
                    originalName: String(entry.originalName || '').slice(0, 512),
                    bytes: Number(entry.bytes) || 0,
                    uploadedAt: entry.uploadedAt || new Date().toISOString(),
                    purpose,
                };
            }
            const key = attachmentObjectKey(entry);
            if (!key || !isAllowedFinanceDocObjectKey(key)) return null;
            return {
                key,
                contentType: 'application/octet-stream',
                originalName: key.split('/').pop() || key,
                bytes: 0,
                uploadedAt: new Date().toISOString(),
                purpose: 'bill',
            };
        })
        .filter(Boolean);
}

function buildStoragePath(apartmentId, txnId, file, index, subfolder = '') {
    const stem = String(file.name || 'file')
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 48) || 'file';
    const ext = (String(file.name || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    return subfolder
        ? `${apartmentId}/${txnId}/${subfolder}/${index}-${stem}.${ext}`
        : `${apartmentId}/${txnId}/${index}-${stem}.${ext}`;
}

async function uploadFiles(service, apartmentId, txnId, files = [], startIndex = 0, subfolder = '') {
    const paths = [];
    for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const path = buildStoragePath(apartmentId, txnId, file, startIndex + i + 1, subfolder);
        const body = Buffer.from(String(file.base64 || ''), 'base64');
        const { error } = await service.storage.from(RECEIPT_BUCKET).upload(path, body, {
            upsert: true,
            contentType: file.mimeType || undefined,
        });
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        paths.push(path);
    }
    return paths;
}

async function referenceExists(service, apartmentId, reference) {
    if (!reference) return false;
    const { data, error } = await service
        .from('transactions')
        .select('id')
        .eq('apartment_id', apartmentId)
        .ilike('bank_reference', String(reference).trim())
        .limit(1);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return !!data?.length;
}

async function saveFinanceDocumentMutation(service, apartmentId, userId, body) {
    const doc = body.document || {};
    const docId = doc.id || crypto.randomUUID();
    const kind = doc.kind === 'IN' ? 'IN' : 'OUT';
    const kept = normalizeKeptAttachments(body.keepAttachments || body.keepAttachmentPaths || []);
    let uploaded = [];
    if (body.newAttachmentFiles?.length) {
        const orgName = await resolveApartmentOrgName(service, apartmentId);
        uploaded = await uploadFinanceDocFilesToR2(apartmentId, body.newAttachmentFiles, { orgName, kind });
    }
    const attachmentUrls = [...kept, ...uploaded];

    const amount = roundMoney(doc.amount);
    if (!(amount > 0)) throw Object.assign(new Error('Enter a valid amount.'), { status: 400 });
    if (!doc.doc_date) throw Object.assign(new Error('Date is required.'), { status: 400 });

    const transactionId = doc.transaction_id || null;
    let status = resolveFinanceDocStatus(doc, transactionId);

    const isNew = !doc.id;
    const payload = {
        id: docId,
        apartment_id: apartmentId,
        kind,
        doc_date: String(doc.doc_date).slice(0, 10),
        amount,
        cat: doc.cat || null,
        sub_category: doc.sub_category || null,
        vendor_name: doc.vendor_name || null,
        description: doc.description || null,
        attachment_urls: attachmentUrls,
        transaction_id: transactionId,
        status,
        source: doc.source === 'excel' ? 'excel' : 'manual',
        source_file: doc.source_file || null,
        notes: doc.notes || null,
        updated_at: new Date().toISOString(),
    };
    if (isNew) payload.created_by = userId || null;

    const { error } = await service.from('finance_documents').upsert(payload);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    if (payload.vendor_name) {
        await service.from('expense_vendors').upsert(
            {
                apartment_id: apartmentId,
                name: payload.vendor_name,
                last_used_at: new Date().toISOString(),
            },
            { onConflict: 'apartment_id,name' },
        );
    }

    if (payload.sub_category && payload.cat && kind === 'OUT') {
        await service.from('expense_sub_categories').upsert(
            {
                apartment_id: apartmentId,
                category: payload.cat,
                name: payload.sub_category,
            },
            { onConflict: 'apartment_id,category,name' },
        );
    }

    await maybeDeleteAttachmentEntries(service, body.removeAttachments || body.removeAttachmentPaths || []);

    const { data: saved, error: readErr } = await service
        .from('finance_documents')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', docId)
        .maybeSingle();
    if (readErr) throw Object.assign(new Error(readErr.message), { status: 500 });

    return {
        ok: true,
        document: saved || payload,
        sub_category_saved: Boolean(payload.sub_category && payload.cat && kind === 'OUT'),
    };
}

async function syncCategoriesBetweenTxnAndDocs(service, apartmentId, txn, documents) {
    const catSet = (c) => Boolean(String(c || '').trim());
    let nextDocs = documents || [];
    let nextTxn = null;
    if (!txn || !nextDocs.length) return { documents: nextDocs, transaction: nextTxn };

    if (catSet(txn.cat)) {
        const patch = {
            cat: txn.cat,
            updated_at: new Date().toISOString(),
        };
        if (catSet(txn.sub_category)) patch.sub_category = txn.sub_category;
        const { data: synced, error: syncErr } = await service
            .from('finance_documents')
            .update(patch)
            .eq('apartment_id', apartmentId)
            .in('id', nextDocs.map((d) => d.id))
            .select('*');
        if (syncErr) throw Object.assign(new Error(syncErr.message), { status: 500 });
        nextDocs = synced || nextDocs;
    } else {
        const donor = nextDocs.find((d) => catSet(d.cat));
        if (donor) {
            const txnPatch = {
                cat: donor.cat,
                sub_category: catSet(donor.sub_category) ? donor.sub_category : null,
            };
            const { data: updatedTxn, error: txnUpErr } = await service
                .from('transactions')
                .update(txnPatch)
                .eq('apartment_id', apartmentId)
                .eq('id', txn.id)
                .select('*')
                .maybeSingle();
            if (txnUpErr) throw Object.assign(new Error(txnUpErr.message), { status: 500 });
            nextTxn = updatedTxn;
        }
    }
    return { documents: nextDocs, transaction: nextTxn };
}

async function syncFinanceDocumentCategoriesMutation(service, apartmentId, body) {
    const docIds = [...new Set((body.document_ids || []).filter(Boolean))];
    if (!docIds.length) {
        throw Object.assign(new Error('Select linked cheque bill(s) to sync categories.'), { status: 400 });
    }

    const { data: docs, error } = await service
        .from('finance_documents')
        .select('*')
        .eq('apartment_id', apartmentId)
        .in('id', docIds);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    const linked = (docs || []).filter((d) => d.transaction_id && d.status === 'linked');
    if (!linked.length) {
        throw Object.assign(new Error('No linked cheque bills in the selection. Cash links are not synced.'), { status: 400 });
    }

    const byTxn = new Map();
    linked.forEach((d) => {
        const list = byTxn.get(d.transaction_id) || [];
        list.push(d);
        byTxn.set(d.transaction_id, list);
    });

    const outDocs = [];
    const outTxns = [];
    for (const [txnId, group] of byTxn.entries()) {
        const { data: txn, error: txnErr } = await service
            .from('transactions')
            .select('id, cat, sub_category, type, wallet')
            .eq('apartment_id', apartmentId)
            .eq('id', txnId)
            .maybeSingle();
        if (txnErr) throw Object.assign(new Error(txnErr.message), { status: 500 });
        if (!txn) continue;
        const { documents: syncedDocs, transaction } = await syncCategoriesBetweenTxnAndDocs(
            service,
            apartmentId,
            txn,
            group,
        );
        outDocs.push(...syncedDocs);
        if (transaction) outTxns.push(transaction);
    }

    return {
        ok: true,
        documents: outDocs,
        transactions: outTxns,
        count: outDocs.length,
        ledger_updated: outTxns.length,
    };
}

async function linkFinanceDocumentsMutation(service, apartmentId, body) {
    const txnId = body.transaction_id;
    const docIds = [...new Set((body.document_ids || []).filter(Boolean))];
    const cashDeskDepositRaw = body.cash_desk_deposit;
    const cashDeskDeposit = cashDeskDepositRaw == null || cashDeskDepositRaw === ''
        ? null
        : Math.max(0, Number(cashDeskDepositRaw) || 0);
    if (!txnId) throw Object.assign(new Error('transaction_id required.'), { status: 400 });
    if (!docIds.length && !(cashDeskDeposit > 0)) {
        throw Object.assign(new Error('Select cash receipts and/or deposit wallet cash toward this bank credit.'), { status: 400 });
    }

    const { data: txn, error: txnErr } = await service
        .from('transactions')
        .select('id, cat, sub_category, type, wallet')
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .maybeSingle();
    if (txnErr) throw Object.assign(new Error(txnErr.message), { status: 500 });
    if (!txn) throw Object.assign(new Error('Ledger row not found.'), { status: 404 });

    let documents = [];
    if (docIds.length) {
        const { data, error } = await service
            .from('finance_documents')
            .update({
                transaction_id: txnId,
                status: 'linked',
                updated_at: new Date().toISOString(),
            })
            .eq('apartment_id', apartmentId)
            .in('id', docIds)
            .select('*');
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        documents = data || [];
    }

    let transaction = null;

    // Cheque ↔ bank only: sync categories. Cash is 1→many so we never sync there.
    if (body.sync_categories === true && documents.length) {
        const synced = await syncCategoriesBetweenTxnAndDocs(service, apartmentId, txn, documents);
        documents = synced.documents;
        transaction = synced.transaction;
    }

    if (cashDeskDeposit != null) {
        const { data: updated, error: depErr } = await service
            .from('transactions')
            .update({ cash_desk_deposit: cashDeskDeposit })
            .eq('apartment_id', apartmentId)
            .eq('id', txnId)
            .select('*')
            .maybeSingle();
        if (depErr && /cash_desk_deposit/i.test(depErr.message)) {
            throw Object.assign(
                new Error('Run the latest finance SQL migration to enable cash desk deposits (cash_desk_deposit column).'),
                { status: 500 },
            );
        }
        if (depErr) throw Object.assign(new Error(depErr.message), { status: 500 });
        transaction = updated || transaction;
    }

    return {
        ok: true,
        documents,
        count: documents.length,
        transaction,
        cash_desk_deposit: cashDeskDeposit,
    };
}

async function unlinkFinanceDocumentsMutation(service, apartmentId, body) {
    const docIds = [...new Set((body.document_ids || []).filter(Boolean))];
    if (!docIds.length) throw Object.assign(new Error('document_ids required.'), { status: 400 });

    // Unlink returns to paid (money already settled; only ledger link removed).
    const { data, error } = await service
        .from('finance_documents')
        .update({
            transaction_id: null,
            status: 'paid',
            updated_at: new Date().toISOString(),
        })
        .eq('apartment_id', apartmentId)
        .in('id', docIds)
        .select('*');
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    return { ok: true, documents: data || [], count: (data || []).length };
}

async function deleteFinanceDocumentMutation(service, apartmentId, body) {
    const docId = body.document_id;
    if (!docId) throw Object.assign(new Error('document_id required.'), { status: 400 });

    const { data: existing } = await service
        .from('finance_documents')
        .select('id, attachment_urls')
        .eq('apartment_id', apartmentId)
        .eq('id', docId)
        .maybeSingle();

    const { error } = await service
        .from('finance_documents')
        .delete()
        .eq('apartment_id', apartmentId)
        .eq('id', docId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    const paths = Array.isArray(existing?.attachment_urls) ? existing.attachment_urls.filter(Boolean) : [];
    await maybeDeleteAttachmentEntries(service, paths);
    return { ok: true };
}

async function importFinanceDocumentsMutation(service, apartmentId, userId, body) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw Object.assign(new Error('No rows to import.'), { status: 400 });

    const sourceFile = body.source_file || null;
    const saved = [];
    for (const row of rows) {
        const result = await saveFinanceDocumentMutation(service, apartmentId, userId, {
            document: {
                kind: row.kind === 'IN' ? 'IN' : 'OUT',
                doc_date: row.doc_date || row.date,
                amount: row.amount,
                cat: row.cat,
                sub_category: row.sub_category,
                vendor_name: row.vendor_name,
                description: row.description,
                notes: row.notes || null,
                source: 'excel',
                source_file: sourceFile,
                status: paymentLooksPaid(row.notes) ? 'paid' : 'unpaid',
            },
            keepAttachmentPaths: [],
            newAttachmentFiles: [],
            removeAttachmentPaths: [],
        });
        saved.push(result.document);
    }
    return { ok: true, count: saved.length, documents: saved };
}

async function setCashFloatFlagMutation(service, apartmentId, body) {
    const txnId = body.transaction_id;
    if (!txnId) throw Object.assign(new Error('transaction_id required.'), { status: 400 });
    const isCashFloat = body.is_cash_float === true;
    const patch = { is_cash_float: isCashFloat };
    if (isCashFloat && body.set_petty_cash_cat !== false) {
        patch.cat = 'Petty Cash';
    }
    // Including in float clears exclude; clearing float mark (or explicit exclude) opts out of buckets.
    if (Object.prototype.hasOwnProperty.call(body, 'exclude_from_cash_float')) {
        patch.exclude_from_cash_float = body.exclude_from_cash_float === true;
    } else if (isCashFloat) {
        patch.exclude_from_cash_float = false;
    } else {
        // Unmarking wallet → stop counting bank Petty Cash as a float bucket.
        patch.exclude_from_cash_float = true;
    }

    let { data, error } = await service
        .from('transactions')
        .update(patch)
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .select('*')
        .maybeSingle();

    // Older DBs may lack exclude_from_cash_float — retry without it.
    if (error && /exclude_from_cash_float/i.test(error.message)) {
        const fallback = { ...patch };
        delete fallback.exclude_from_cash_float;
        ({ data, error } = await service
            .from('transactions')
            .update(fallback)
            .eq('apartment_id', apartmentId)
            .eq('id', txnId)
            .select('*')
            .maybeSingle());
        if (!error && data && patch.exclude_from_cash_float) {
            // Column missing: fall back to clearing Petty Cash so isBankPettyFunding drops the line.
            if (String(data.cat || '').toLowerCase() === 'petty cash') {
                const retry = await service
                    .from('transactions')
                    .update({ cat: 'Other', exclude_from_reports: true })
                    .eq('apartment_id', apartmentId)
                    .eq('id', txnId)
                    .select('*')
                    .maybeSingle();
                if (!retry.error && retry.data) data = retry.data;
            }
        }
    }

    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true, transaction: data };
}

async function saveTransactionMutation(service, apartmentId, body) {
    const txn = body.transaction || {};
    const txnId = txn.id || crypto.randomUUID();
    let receiptUrls = [...(body.keepReceiptPaths || [])];
    let bankProofUrls = [...(body.keepBankProofPaths || [])];
    if (body.newReceiptFiles?.length) {
        receiptUrls = receiptUrls.concat(await uploadFiles(service, apartmentId, txnId, body.newReceiptFiles, receiptUrls.length));
    }
    if (txn.wallet === 'BANK' && body.newBankProofFiles?.length) {
        bankProofUrls = bankProofUrls.concat(
            await uploadFiles(service, apartmentId, txnId, body.newBankProofFiles, bankProofUrls.length, 'bank'),
        );
    }

    const payload = {
        ...txn,
        id: txnId,
        apartment_id: apartmentId,
        receipt_url: receiptUrls[0] || null,
        receipt_urls: receiptUrls,
        bank_proof_urls: txn.wallet === 'BANK' ? bankProofUrls : [],
    };

    let { error } = await service.from('transactions').upsert(payload);
    if (error && /sub_category|receipt_url|receipt_urls|vendor_name|vendor_invoice|bank_payment_type|bank_reference|bank_proof_urls|exclude_from_reports/i.test(error.message)) {
        const core = { ...payload };
        delete core.sub_category;
        delete core.receipt_url;
        delete core.receipt_urls;
        delete core.vendor_name;
        delete core.vendor_invoice;
        delete core.bank_payment_type;
        delete core.bank_reference;
        delete core.bank_proof_urls;
        delete core.exclude_from_reports;
        ({ error } = await service.from('transactions').upsert(core));
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    if (txn.cat === 'Maintenance Collection') {
        const { error: delErr } = await service
            .from('maintenance_payment_allocations')
            .delete()
            .eq('transaction_id', txnId);
        if (delErr && !/maintenance_payment_allocations/i.test(delErr.message)) {
            throw Object.assign(new Error(delErr.message), { status: 500 });
        }
        const allocations = Array.isArray(body.allocations) ? body.allocations.filter((row) => parseFloat(row.amount || 0) > 0) : [];
        if (allocations.length && !delErr) {
            const { error: allocErr } = await service.from('maintenance_payment_allocations').insert(
                allocations.map((row) => ({
                    id: crypto.randomUUID(),
                    apartment_id: apartmentId,
                    transaction_id: txnId,
                    invoice_id: row.invoice_id,
                    amount: roundMoney(row.amount),
                })),
            );
            if (allocErr) throw Object.assign(new Error(allocErr.message), { status: 500 });
        }
    }

    if (txn.vendor_name) {
        await service.from('expense_vendors').upsert(
            {
                apartment_id: apartmentId,
                name: txn.vendor_name,
                last_used_at: new Date().toISOString(),
            },
            { onConflict: 'apartment_id,name' },
        );
    }
    if (txn.sub_category && txn.cat) {
        await service.from('expense_sub_categories').upsert(
            {
                apartment_id: apartmentId,
                category: txn.cat,
                name: txn.sub_category,
                last_used_at: new Date().toISOString(),
            },
            { onConflict: 'apartment_id,category,name' },
        );
    }

    await maybeDeletePaths(service, body.removeReceiptPaths || []);
    await maybeDeletePaths(service, body.removeBankProofPaths || []);

    const { data: saved, error: readErr } = await service
        .from('transactions')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .maybeSingle();
    if (readErr) throw Object.assign(new Error(readErr.message), { status: 500 });

    return { ok: true, txnId, transaction: saved || payload };
}

async function deleteTransactionMutation(service, apartmentId, body) {
    const txnId = body.transaction_id;
    if (!txnId) throw Object.assign(new Error('transaction_id is required.'), { status: 400 });

    const { data: txn, error: fetchErr } = await service
        .from('transactions')
        .select('id, receipt_urls, receipt_url, bank_proof_urls')
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .maybeSingle();
    if (fetchErr) throw Object.assign(new Error(fetchErr.message), { status: 500 });

    await service.from('maintenance_payment_allocations').delete().eq('transaction_id', txnId);
    const { error } = await service.from('transactions').delete().eq('apartment_id', apartmentId).eq('id', txnId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    const receiptPaths = Array.isArray(txn?.receipt_urls)
        ? txn.receipt_urls
        : (txn?.receipt_url ? [txn.receipt_url] : []);
    const bankProofPaths = Array.isArray(txn?.bank_proof_urls) ? txn.bank_proof_urls : [];
    await maybeDeletePaths(service, [...receiptPaths, ...bankProofPaths]);

    return { ok: true };
}

async function deleteTransactionsMutation(service, apartmentId, body) {
    const ids = [...new Set((body.transaction_ids || []).filter(Boolean))];
    if (!ids.length) return { ok: true, deleted: 0 };

    const { data: txns, error: fetchErr } = await service
        .from('transactions')
        .select('id, receipt_urls, receipt_url, bank_proof_urls')
        .eq('apartment_id', apartmentId)
        .in('id', ids);
    if (fetchErr) throw Object.assign(new Error(fetchErr.message), { status: 500 });

    await service.from('maintenance_payment_allocations').delete().in('transaction_id', ids);

    // Unlink matched statement lines so they don't point at deleted txns.
    await service
        .from('bank_statement_lines')
        .update({
            match_status: 'UNMATCHED',
            transaction_id: null,
            matched_at: null,
            matched_by: null,
        })
        .eq('apartment_id', apartmentId)
        .in('transaction_id', ids);

    const { error } = await service.from('transactions').delete().eq('apartment_id', apartmentId).in('id', ids);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    const paths = [];
    for (const txn of txns || []) {
        if (Array.isArray(txn.receipt_urls)) paths.push(...txn.receipt_urls);
        else if (txn.receipt_url) paths.push(txn.receipt_url);
        if (Array.isArray(txn.bank_proof_urls)) paths.push(...txn.bank_proof_urls);
    }
    await maybeDeletePaths(service, paths);

    return { ok: true, deleted: ids.length };
}

async function saveCashFloatOpeningMutation(service, apartmentId, body) {
    const date = body.date ? String(body.date).slice(0, 10) : null;
    const amountRaw = body.amount;
    const amount = amountRaw == null || amountRaw === '' ? null : parseFloat(amountRaw);
    if (amount != null && Number.isNaN(amount)) {
        throw Object.assign(new Error('Enter a valid opening cash amount.'), { status: 400 });
    }
    if (amount != null && !date) {
        throw Object.assign(new Error('Enter the opening cash date.'), { status: 400 });
    }

    const bank = body.bank && typeof body.bank === 'object' ? body.bank : {};
    const { data: existing } = await service
        .from('apartment_bank_accounts')
        .select('*')
        .eq('apartment_id', apartmentId)
        .maybeSingle();

    const payload = {
        id: existing?.id || bank.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        bank_name: existing?.bank_name || bank.bank_name || 'Bank account',
        cash_float_opening_balance: amount,
        cash_float_opening_date: amount == null ? null : date,
        updated_at: new Date().toISOString(),
    };
    ['branch', 'account_holder', 'account_number', 'ifsc', 'upi_id', 'notes',
        'opening_balance', 'opening_balance_date'].forEach((key) => {
        if (existing?.[key] != null) payload[key] = existing[key];
        else if (bank[key] != null) payload[key] = bank[key];
    });

    let { data, error } = await service
        .from('apartment_bank_accounts')
        .upsert(payload, { onConflict: 'apartment_id' })
        .select('*')
        .maybeSingle();

    if (error && /cash_float_opening/i.test(error.message)) {
        throw Object.assign(
            new Error('Run the cash float opening SQL migration (cash_float_opening_balance on apartment_bank_accounts).'),
            { status: 500 },
        );
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return {
        ok: true,
        bankAccount: data,
        amount: data?.cash_float_opening_balance ?? null,
        date: data?.cash_float_opening_date || null,
    };
}

async function saveBankOpeningBalanceMutation(service, apartmentId, body) {
    const { date, amount } = body;
    const bank = body.bank && typeof body.bank === 'object' ? body.bank : {};
    if (!date) throw Object.assign(new Error('Enter the opening balance date.'), { status: 400 });
    if (amount == null || Number.isNaN(parseFloat(amount))) {
        throw Object.assign(new Error('Enter the opening balance amount.'), { status: 400 });
    }
    const payload = {
        id: bank.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        bank_name: bank.bank_name || 'Bank account',
        opening_balance_date: date,
        opening_balance: parseFloat(amount),
        updated_at: new Date().toISOString(),
    };
    ['branch', 'account_holder', 'account_number', 'ifsc', 'upi_id', 'notes'].forEach((key) => {
        if (bank[key]) payload[key] = bank[key];
    });
    const { error } = await service.from('apartment_bank_accounts').upsert(payload, { onConflict: 'apartment_id' });
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    await persistComputedBalances(service, apartmentId, {
        amount: parseFloat(amount),
        date,
    });
    return { ok: true };
}

async function getBankOpeningForApartment(service, apartmentId) {
    const { data, error } = await service
        .from('apartment_bank_accounts')
        .select('*')
        .eq('apartment_id', apartmentId)
        .maybeSingle();
    if (error) {
        if (/opening_balance/i.test(error.message)) {
            return { amount: null, date: null };
        }
        throw Object.assign(new Error(error.message), { status: 500 });
    }
    return {
        amount: data?.opening_balance ?? null,
        date: data?.opening_balance_date || null,
    };
}

async function fetchApartmentStatementLines(service, apartmentId) {
    const { data, error } = await service
        .from('bank_statement_lines')
        .select('id, apartment_id, line_date, debit, credit, line_order, source_row_index, order_source, import_id')
        .eq('apartment_id', apartmentId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data || [];
}

async function fetchApartmentImportMap(service, apartmentId) {
    const { data, error } = await service
        .from('bank_statement_imports')
        .select('id, file_name, created_at')
        .eq('apartment_id', apartmentId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return new Map((data || []).map((row) => [row.id, row]));
}

async function persistComputedBalances(service, apartmentId, opening) {
    const lines = await fetchApartmentStatementLines(service, apartmentId);
    const importById = await fetchApartmentImportMap(service, apartmentId);
    const balances = computeRunningBalances(lines, opening, importById);
    const entries = [...balances.entries()];
    const batchSize = 25;

    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        await Promise.all(batch.map(async ([id, computed_balance]) => {
            const { error } = await service
                .from('bank_statement_lines')
                .update({ computed_balance })
                .eq('apartment_id', apartmentId)
                .eq('id', id);
            if (error && !/computed_balance/i.test(error.message)) {
                throw Object.assign(new Error(error.message), { status: 500 });
            }
        }));
    }
}

async function importBankStatementMutation(service, apartmentId, userId, body) {
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (!rawLines.length) return { importId: null, count: 0 };

    const opening = await getBankOpeningForApartment(service, apartmentId);
    const lines = prepareImportedStatementLines(rawLines, opening);
    const importId = crypto.randomUUID();
    const dates = lines.map((l) => l.line_date).filter(Boolean).sort();

    // Append onto existing same-day rows so a later upload cannot reuse 0..n
    // and fight earlier files for sort position.
    const maxOrderByDate = new Map();
    const uniqueDates = [...new Set(lines.map((l) => l.line_date).filter(Boolean))];
    if (uniqueDates.length) {
        const { data: existing, error: existingErr } = await service
            .from('bank_statement_lines')
            .select('line_date, line_order')
            .eq('apartment_id', apartmentId)
            .in('line_date', uniqueDates);
        if (existingErr) throw Object.assign(new Error(existingErr.message), { status: 500 });
        for (const row of existing || []) {
            const key = row.line_date;
            maxOrderByDate.set(key, Math.max(maxOrderByDate.get(key) ?? -1, row.line_order ?? 0));
        }
    }

    const { error: impErr } = await service.from('bank_statement_imports').insert({
        id: importId,
        apartment_id: apartmentId,
        bank_account_id: body.bank_account_id || null,
        file_name: body.file_name || 'import.xlsx',
        period_start: dates[0] || null,
        period_end: dates[dates.length - 1] || null,
        imported_by: userId || null,
    });
    if (impErr) throw Object.assign(new Error(impErr.message), { status: 500 });

    const payload = lines.map((line) => {
        const date = line.line_date || '';
        const localOrder = line.line_order ?? 0;
        const offset = date && maxOrderByDate.has(date) ? maxOrderByDate.get(date) + 1 : 0;
        return {
            id: crypto.randomUUID(),
            import_id: importId,
            apartment_id: apartmentId,
            line_date: line.line_date,
            description: line.description || null,
            debit: line.debit || 0,
            credit: line.credit || 0,
            balance: line.balance ?? null,
            line_order: offset + localOrder,
            source_row_index: line.source_row_index ?? null,
            order_source: line.order_source || 'auto',
            match_status: 'UNMATCHED',
        };
    });
    const { error: lineErr } = await service.from('bank_statement_lines').insert(payload);
    if (lineErr) throw Object.assign(new Error(lineErr.message), { status: 500 });
    await persistComputedBalances(service, apartmentId, opening);
    return { importId, count: payload.length };
}

async function reorderBankStatementLinesMutation(service, apartmentId, body) {
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (!updates.length) {
        throw Object.assign(new Error('updates array is required.'), { status: 400 });
    }
    const rows = updates.filter((row) => row?.id);
    const batchSize = 25;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await Promise.all(batch.map(async (row) => {
            const { error } = await service.from('bank_statement_lines').update({
                line_order: row.line_order ?? 0,
                order_source: row.order_source || 'manual',
            }).eq('apartment_id', apartmentId).eq('id', row.id);
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
        }));
    }
    if (body.recalculate_balances === true) {
        const opening = await getBankOpeningForApartment(service, apartmentId);
        await persistComputedBalances(service, apartmentId, opening);
    }
    return { ok: true };
}

async function recalculateBankStatementBalancesMutation(service, apartmentId) {
    const opening = await getBankOpeningForApartment(service, apartmentId);
    await persistComputedBalances(service, apartmentId, opening);
    return { ok: true };
}

async function updateBankLineMatchMutation(service, apartmentId, userId, body, mode) {
    const lineId = body.line_id;
    const payload = mode === 'match'
        ? {
            match_status: 'MATCHED',
            transaction_id: body.transaction_id,
            matched_at: new Date().toISOString(),
            matched_by: userId || null,
        }
        : mode === 'unmatch'
            ? { match_status: 'UNMATCHED', transaction_id: null, matched_at: null, matched_by: null }
            : { match_status: 'IGNORED', transaction_id: null, matched_at: null, matched_by: null };
    const { error } = await service.from('bank_statement_lines').update(payload).eq('apartment_id', apartmentId).eq('id', lineId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true };
}

async function bulkUpdateBankLineMatchMutation(service, apartmentId, userId, body, mode) {
    const ids = [...new Set((body.line_ids || []).filter(Boolean))];
    if (!ids.length) return { ok: true, updated: 0 };

    const payload = mode === 'match'
        ? {
            match_status: 'MATCHED',
            transaction_id: body.transaction_id,
            matched_at: new Date().toISOString(),
            matched_by: userId || null,
        }
        : mode === 'unmatch'
            ? { match_status: 'UNMATCHED', transaction_id: null, matched_at: null, matched_by: null }
            : { match_status: 'IGNORED', transaction_id: null, matched_at: null, matched_by: null };

    const { error } = await service
        .from('bank_statement_lines')
        .update(payload)
        .eq('apartment_id', apartmentId)
        .in('id', ids);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true, updated: ids.length };
}

async function updateBankStatementLineMutation(service, apartmentId, body) {
    const allowed = ['line_date', 'description', 'debit', 'credit', 'balance'];
    const payload = {};
    allowed.forEach((key) => {
        if (key in (body.patch || {})) payload[key] = body.patch[key];
    });
    if (!Object.keys(payload).length) return { ok: true };
    const { error } = await service.from('bank_statement_lines').update(payload).eq('apartment_id', apartmentId).eq('id', body.line_id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    if ('line_date' in payload || 'debit' in payload || 'credit' in payload) {
        const opening = await getBankOpeningForApartment(service, apartmentId);
        await persistComputedBalances(service, apartmentId, opening);
    }
    return { ok: true };
}

async function deleteBankStatementLinesMutation(service, apartmentId, body) {
    const ids = [...new Set((body.line_ids || []).filter(Boolean))];
    if (!ids.length) return { ok: true };
    const { error } = await service.from('bank_statement_lines').delete().eq('apartment_id', apartmentId).in('id', ids);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    const opening = await getBankOpeningForApartment(service, apartmentId);
    await persistComputedBalances(service, apartmentId, opening);
    return { ok: true, deleted: ids.length };
}

async function clearBankStatementDataMutation(service, apartmentId) {
    const { error } = await service.from('bank_statement_imports').delete().eq('apartment_id', apartmentId);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true };
}

async function createTxnFromBankLineMutation(service, apartmentId, body) {
    const { data: line, error: lineErr } = await service
        .from('bank_statement_lines')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', body.line_id)
        .maybeSingle();
    if (lineErr) throw Object.assign(new Error(lineErr.message), { status: 500 });
    if (!line) throw Object.assign(new Error('Statement line not found.'), { status: 404 });

    const isIncome = bankLineType(line) === 'IN';
    const amount = bankLineAmount(line);
    if (amount <= 0.001) throw Object.assign(new Error('Enter a debit or credit amount.'), { status: 400 });
    if (!body.cat) throw Object.assign(new Error('Select a category.'), { status: 400 });
    if (!isIncome && !body.sub_category) throw Object.assign(new Error('Enter sub-category for expenses.'), { status: 400 });
    if (!isIncome && !body.vendor_name) throw Object.assign(new Error('Enter vendor name for expenses.'), { status: 400 });

    const txnId = crypto.randomUUID();
    const payload = {
        id: txnId,
        apartment_id: apartmentId,
        amount,
        cat: body.cat,
        sub_category: isIncome ? null : (body.sub_category || null),
        vendor_name: isIncome ? null : body.vendor_name,
        vendor_invoice: null,
        bank_payment_type: null,
        bank_reference: (line.description || '').slice(0, 120) || null,
        bank_proof_urls: [],
        description: line.description || null,
        wallet: 'BANK',
        type: isIncome ? 'IN' : 'OUT',
        date: new Date(`${line.line_date}T12:00:00`).toISOString(),
        receipt_url: null,
        receipt_urls: [],
        exclude_from_reports: Boolean(body.exclude_from_reports) || body.cat === BANK_REJECT_CAT,
    };

    let { error } = await service.from('transactions').insert(payload);
    if (error && /sub_category|vendor_name|bank_reference|bank_proof_urls|exclude_from_reports/i.test(error.message)) {
        const core = { ...payload };
        delete core.sub_category;
        delete core.vendor_name;
        delete core.vendor_invoice;
        delete core.bank_payment_type;
        delete core.bank_reference;
        delete core.bank_proof_urls;
        delete core.receipt_url;
        delete core.receipt_urls;
        delete core.exclude_from_reports;
        ({ error } = await service.from('transactions').insert(core));
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    const { error: matchErr } = await service.from('bank_statement_lines').update({
        match_status: 'MATCHED',
        transaction_id: txnId,
        matched_at: new Date().toISOString(),
    }).eq('apartment_id', apartmentId).eq('id', body.line_id);
    if (matchErr) throw Object.assign(new Error(matchErr.message), { status: 500 });

    return { ok: true, txnId };
}

async function createTxnsFromBankLinesMutation(service, apartmentId, userId, body) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return { ok: true, posted: 0, failed: 0, results: [] };

    const uniqueLineIds = [...new Set(rows.map((r) => r?.line_id).filter(Boolean))];
    const { data: lines, error: lineErr } = await service
        .from('bank_statement_lines')
        .select('*')
        .eq('apartment_id', apartmentId)
        .in('id', uniqueLineIds);
    if (lineErr) throw Object.assign(new Error(lineErr.message), { status: 500 });
    const byId = new Map((lines || []).map((l) => [l.id, l]));

    let posted = 0;
    let failed = 0;
    const results = [];

    for (const row of rows) {
        const lineId = row?.line_id;
        try {
            const line = byId.get(lineId);
            if (!line) throw new Error('Statement line not found.');
            if (line.match_status !== 'UNMATCHED') throw new Error('Statement line is not available for import.');

            const isIncome = bankLineType(line) === 'IN';
            const amount = bankLineAmount(line);
            if (amount <= 0.001) throw new Error('Enter a debit or credit amount.');
            if (!row.cat) throw new Error('Select a category.');
            if (!isIncome && !row.sub_category) throw new Error('Enter sub-category for expenses.');
            if (!isIncome && !row.vendor_name) throw new Error('Enter vendor name for expenses.');

            const txnId = crypto.randomUUID();
            const payload = {
                id: txnId,
                apartment_id: apartmentId,
                amount,
                cat: row.cat,
                sub_category: isIncome ? null : (row.sub_category || null),
                vendor_name: isIncome ? null : row.vendor_name,
                vendor_invoice: null,
                bank_payment_type: null,
                bank_reference: (line.description || '').slice(0, 120) || null,
                bank_proof_urls: [],
                description: line.description || null,
                wallet: 'BANK',
                type: isIncome ? 'IN' : 'OUT',
                date: new Date(`${line.line_date}T12:00:00`).toISOString(),
                receipt_url: null,
                receipt_urls: [],
                exclude_from_reports: Boolean(row.exclude_from_reports) || row.cat === BANK_REJECT_CAT,
            };

            let { error } = await service.from('transactions').insert(payload);
            if (error && /sub_category|vendor_name|bank_reference|bank_proof_urls|exclude_from_reports/i.test(error.message)) {
                const core = { ...payload };
                delete core.sub_category;
                delete core.vendor_name;
                delete core.vendor_invoice;
                delete core.bank_payment_type;
                delete core.bank_reference;
                delete core.bank_proof_urls;
                delete core.receipt_url;
                delete core.receipt_urls;
                delete core.exclude_from_reports;
                ({ error } = await service.from('transactions').insert(core));
            }
            if (error) throw new Error(error.message);

            const { error: matchErr } = await service.from('bank_statement_lines').update({
                match_status: 'MATCHED',
                transaction_id: txnId,
                matched_at: new Date().toISOString(),
                matched_by: userId || null,
            }).eq('apartment_id', apartmentId).eq('id', lineId);
            if (matchErr) throw new Error(matchErr.message);

            posted += 1;
            results.push({ line_id: lineId, ok: true, txnId });
        } catch (e) {
            failed += 1;
            results.push({ line_id: lineId, ok: false, error: e?.message || String(e) });
        }
    }

    return { ok: true, posted, failed, results };
}

async function loadUnitsAndInvoices(service, apartmentId) {
    const [{ data: units, error: unitsErr }, { data: invoices, error: invoicesErr }, { data: allocations, error: allocErr }] = await Promise.all([
        service.from('units').select('id, number').eq('apartment_id', apartmentId),
        service.from('maintenance_invoices').select('id, unit_id, amount, amount_paid, due_date, period_label, billing_group_id').eq('apartment_id', apartmentId),
        service.from('maintenance_payment_allocations').select('invoice_id, amount').eq('apartment_id', apartmentId),
    ]);
    if (unitsErr) throw Object.assign(new Error(unitsErr.message), { status: 500 });
    if (invoicesErr) throw Object.assign(new Error(invoicesErr.message), { status: 500 });
    if (allocErr && !/maintenance_payment_allocations/i.test(allocErr.message)) {
        throw Object.assign(new Error(allocErr.message), { status: 500 });
    }
    return { units: units || [], invoices: invoices || [], allocations: allocations || [] };
}

async function createMaintenanceCollectionPayment(service, apartmentId, line, unitNumber, amount, description, bankReference, bankPaymentType) {
    const { units, invoices, allocations } = await loadUnitsAndInvoices(service, apartmentId);
    const unit = units.find((row) => String(row.number || '').trim().toUpperCase() === String(unitNumber || '').trim().toUpperCase());
    if (!unit) throw Object.assign(new Error(`Unknown flat: ${unitNumber}`), { status: 400 });
    if (await referenceExists(service, apartmentId, bankReference)) {
        throw Object.assign(new Error(`Reference ${bankReference} is already recorded in the ledger.`), { status: 400 });
    }

    const paidByInvoice = new Map();
    for (const alloc of allocations || []) {
        paidByInvoice.set(alloc.invoice_id, roundMoney((paidByInvoice.get(alloc.invoice_id) || 0) + parseFloat(alloc.amount || 0)));
    }
    const openInvoices = invoices
        .filter((inv) => inv.unit_id === unit.id)
        .map((inv) => ({ ...inv, open: Math.max(0, roundMoney(parseFloat(inv.amount || 0) - (paidByInvoice.get(inv.id) || 0))) }))
        .filter((inv) => inv.open > 0.001)
        .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));

    let remaining = parseFloat(amount);
    const allocRows = [];
    openInvoices.forEach((inv) => {
        if (remaining <= 0.001) return;
        const apply = Math.min(remaining, inv.open);
        if (apply <= 0.001) return;
        allocRows.push({ invoice_id: inv.id, amount: roundMoney(apply) });
        remaining = roundMoney(remaining - apply);
    });

    const txnId = crypto.randomUUID();
    const core = {
        id: txnId,
        apartment_id: apartmentId,
        amount: parseFloat(amount),
        cat: 'Maintenance Collection',
        description: description || `Maintenance collection — ${unitNumber}`,
        wallet: 'BANK',
        type: 'IN',
        date: new Date(`${line.line_date}T12:00:00`).toISOString(),
    };
    let { error } = await service.from('transactions').insert({
        ...core,
        bank_payment_type: bankPaymentType,
        bank_reference: bankReference,
    });
    if (error && /bank_payment_type|bank_reference/i.test(error.message)) {
        ({ error } = await service.from('transactions').insert(core));
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });

    if (allocRows.length) {
        const { error: allocInsertErr } = await service.from('maintenance_payment_allocations').insert(
            allocRows.map((row) => ({
                id: crypto.randomUUID(),
                apartment_id: apartmentId,
                transaction_id: txnId,
                invoice_id: row.invoice_id,
                amount: row.amount,
            })),
        );
        if (allocInsertErr && !/maintenance_payment_allocations/i.test(allocInsertErr.message)) {
            throw Object.assign(new Error(allocInsertErr.message), { status: 500 });
        }
    }
    return txnId;
}

async function createLedgerFromBankLineAutoMutation(service, apartmentId, body) {
    const { data: line, error: lineErr } = await service
        .from('bank_statement_lines')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', body.line_id)
        .maybeSingle();
    if (lineErr) throw Object.assign(new Error(lineErr.message), { status: 500 });
    if (!line || line.match_status !== 'UNMATCHED') {
        throw Object.assign(new Error('Statement line is not available for import.'), { status: 400 });
    }

    const amount = bankLineAmount(line);
    if (amount <= 0.001) throw Object.assign(new Error('Statement line has no debit or credit amount.'), { status: 400 });

    const type = bankLineType(line);
    const nb = body.nobroker_row || null;
    const desc = line.description || nb?.description || '';
    let txnId;

    if (type === 'IN') {
        const { data: units } = await service.from('units').select('id, number').eq('apartment_id', apartmentId);
        const flat = nb?.flatHint || matchFlatFromText(desc, units || []) || matchFlatFromText(nb?.description, units || []);
        const incomeCat = inferIncomeCategory(desc);
        const bankRef = nb?.reference || statementReference(body.line_id);
        if (flat && (nb || incomeCat === 'Maintenance Collection')) {
            txnId = await createMaintenanceCollectionPayment(
                service,
                apartmentId,
                line,
                flat,
                amount,
                desc || `Bank collection — ${flat}`,
                bankRef,
                nb ? 'UPI' : inferBankPaymentType(desc),
            );
        } else {
            if (await referenceExists(service, apartmentId, bankRef)) {
                throw Object.assign(new Error(`Reference ${bankRef} is already recorded in the ledger.`), { status: 400 });
            }
            const core = {
                id: crypto.randomUUID(),
                apartment_id: apartmentId,
                amount,
                cat: incomeCat,
                description: desc || `Bank credit — ${incomeCat}`,
                wallet: 'BANK',
                type: 'IN',
                date: new Date(`${line.line_date}T12:00:00`).toISOString(),
            };
            let { error } = await service.from('transactions').insert({
                ...core,
                bank_payment_type: inferBankPaymentType(desc),
                bank_reference: bankRef,
            });
            if (error && /bank_payment_type|bank_reference/i.test(error.message)) {
                ({ error } = await service.from('transactions').insert(core));
            }
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            txnId = core.id;
        }
    } else {
        const bankRef = statementReference(body.line_id);
        if (await referenceExists(service, apartmentId, bankRef)) {
            throw Object.assign(new Error(`This statement line was already imported (${bankRef}).`), { status: 400 });
        }
        const cat = inferExpenseCategory(desc);
        const core = {
            id: crypto.randomUUID(),
            apartment_id: apartmentId,
            amount,
            cat,
            description: desc || `Bank debit — ${cat}`,
            wallet: 'BANK',
            type: 'OUT',
            date: new Date(`${line.line_date}T12:00:00`).toISOString(),
        };
        let { error } = await service.from('transactions').insert({
            ...core,
            bank_payment_type: inferBankPaymentType(desc),
            bank_reference: bankRef,
            vendor_name: (desc || '').slice(0, 120) || null,
        });
        if (error && /bank_payment_type|bank_reference|vendor_name/i.test(error.message)) {
            ({ error } = await service.from('transactions').insert(core));
        }
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        txnId = core.id;
    }

    const { error: matchErr } = await service.from('bank_statement_lines').update({
        match_status: 'MATCHED',
        transaction_id: txnId,
        matched_at: new Date().toISOString(),
    }).eq('apartment_id', apartmentId).eq('id', body.line_id);
    if (matchErr) throw Object.assign(new Error(matchErr.message), { status: 500 });
    return { ok: true, txnId };
}

async function previewBankClassificationRulesMutation(service, apartmentId) {
    const { data: rules, error: rulesErr } = await service
        .from('bank_classification_rules')
        .select('*')
        .eq('apartment_id', apartmentId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
    if (rulesErr) throw Object.assign(new Error(rulesErr.message), { status: 500 });

    const { data: lines, error: linesErr } = await service
        .from('bank_statement_lines')
        .select('id, description, debit, credit, match_status')
        .eq('apartment_id', apartmentId)
        .eq('match_status', 'UNMATCHED');
    if (linesErr) throw Object.assign(new Error(linesErr.message), { status: 500 });

    const matches = [];
    let noRule = 0;
    for (const line of lines || []) {
        const rule = findMatchingRule(line, rules || []);
        if (!rule) {
            noRule += 1;
            continue;
        }
        matches.push({
            line_id: line.id,
            rule_id: rule.id,
            category: rule.category,
            sub_category: rule.sub_category,
            vendor_name: rule.vendor_name,
            exclude_from_reports: !!rule.exclude_from_reports,
        });
    }

    const sampleLine = (lines || []).find((l) => l.description?.trim());
    return {
        matches,
        ruleCount: (rules || []).length,
        examined: (lines || []).length,
        noRule,
        sampleLineDescription: sampleLine?.description?.slice(0, 100) || null,
        sampleRuleMatch: rules?.[0]?.description_match?.slice(0, 100) || null,
    };
}

async function listBankClassificationRulesMutation(service, apartmentId) {
    const { data, error } = await service
        .from('bank_classification_rules')
        .select('*')
        .eq('apartment_id', apartmentId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { rules: data || [] };
}

async function saveBankClassificationRuleMutation(service, apartmentId, body) {
    const match = String(body.description_match || '').trim();
    const category = String(body.category || '').trim();
    if (!match) throw Object.assign(new Error('Description match text is required.'), { status: 400 });
    if (!category) throw Object.assign(new Error('Category is required.'), { status: 400 });
    const lineType = body.line_type === 'IN' ? 'IN' : 'OUT';
    const payload = {
        id: body.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        line_type: lineType,
        description_match: match,
        category,
        sub_category: body.sub_category?.trim() || null,
        vendor_name: body.vendor_name?.trim() || null,
        priority: Number.isFinite(body.priority) ? body.priority : 0,
        enabled: body.enabled !== false,
        exclude_from_reports: Boolean(body.exclude_from_reports),
        updated_at: new Date().toISOString(),
    };
    let { data, error } = await service.from('bank_classification_rules').upsert(payload).select('*').single();
    if (error && /exclude_from_reports/i.test(error.message)) {
        delete payload.exclude_from_reports;
        ({ data, error } = await service.from('bank_classification_rules').upsert(payload).select('*').single());
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true, rule: data };
}

async function deleteBankClassificationRuleMutation(service, apartmentId, body) {
    const id = body.id || body.rule_id;
    if (!id) throw Object.assign(new Error('Rule id is required.'), { status: 400 });
    const { error } = await service.from('bank_classification_rules')
        .delete()
        .eq('apartment_id', apartmentId)
        .eq('id', id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true };
}

async function bulkUpdateTransactionsMutation(service, apartmentId, body) {
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (!updates.length) return { ok: true, updated: 0 };

    const allowed = new Set(['cat', 'sub_category', 'description', 'exclude_from_reports', 'vendor_name', 'excluded_from_ledger']);
    let updated = 0;

    for (const item of updates) {
        const id = item?.id;
        const fields = item?.fields || {};
        if (!id || !Object.keys(fields).length) continue;

        const { data: existing, error: fetchErr } = await service
            .from('transactions')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) throw Object.assign(new Error(fetchErr.message), { status: 500 });
        if (!existing) continue;

        const patch = {};
        for (const [key, value] of Object.entries(fields)) {
            if (allowed.has(key)) patch[key] = value;
        }
        if (patch.cat === BANK_REJECT_CAT && patch.exclude_from_reports === undefined) {
            patch.exclude_from_reports = true;
        }
        if (!Object.keys(patch).length) continue;

        const payload = { ...existing, ...patch, apartment_id: apartmentId, id };
        let { error } = await service.from('transactions').upsert(payload);
        if (error && /sub_category|vendor_name|exclude_from_reports|excluded_from_ledger/i.test(error.message)) {
            const core = { ...payload };
            delete core.sub_category;
            delete core.vendor_name;
            delete core.exclude_from_reports;
            delete core.excluded_from_ledger;
            ({ error } = await service.from('transactions').upsert(core));
        }
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        updated += 1;
    }

    return { ok: true, updated };
}

function txnDateToLineDate(txn) {
    const raw = txn?.date;
    if (!raw) throw Object.assign(new Error('Transaction has no date.'), { status: 400 });
    const iso = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) throw Object.assign(new Error('Invalid transaction date.'), { status: 400 });
    return dt.toISOString().slice(0, 10);
}

/** Orphan BANK ledger entry → unmatched statement line; deletes the transaction. */
async function returnLedgerTxnToStatementMutation(service, apartmentId, userId, body) {
    const txnId = body.transaction_id;
    if (!txnId) throw Object.assign(new Error('transaction_id is required.'), { status: 400 });

    const { data: txn, error: txnErr } = await service
        .from('transactions')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .maybeSingle();
    if (txnErr) throw Object.assign(new Error(txnErr.message), { status: 500 });
    if (!txn) throw Object.assign(new Error('Transaction not found.'), { status: 404 });
    if ((txn.wallet || '').toUpperCase() !== 'BANK') {
        throw Object.assign(new Error('Only BANK ledger entries can be returned to statement lines.'), { status: 400 });
    }

    const { data: linkedLine, error: linkErr } = await service
        .from('bank_statement_lines')
        .select('id')
        .eq('apartment_id', apartmentId)
        .eq('transaction_id', txnId)
        .eq('match_status', 'MATCHED')
        .maybeSingle();
    if (linkErr) throw Object.assign(new Error(linkErr.message), { status: 500 });
    if (linkedLine) {
        throw Object.assign(new Error('This entry is already linked to a statement line. Unmatch it first.'), { status: 400 });
    }

    const amount = parseFloat(txn.amount) || 0;
    if (amount <= 0.001) throw Object.assign(new Error('Transaction amount is invalid.'), { status: 400 });
    const isIncome = txn.type === 'IN';
    const lineDate = txnDateToLineDate(txn);
    const description = txn.description || txn.bank_reference || txn.cat || null;

    const importResult = await importBankStatementMutation(service, apartmentId, userId, {
        lines: [{
            line_date: lineDate,
            description,
            debit: isIncome ? 0 : amount,
            credit: isIncome ? amount : 0,
        }],
        file_name: `ledger-return:${txnId.slice(0, 8)}`,
    });

    if (!importResult?.count) {
        throw Object.assign(new Error('Could not create statement line.'), { status: 500 });
    }

    let lineId = null;
    if (importResult.importId) {
        const { data: newLines, error: lineFetchErr } = await service
            .from('bank_statement_lines')
            .select('id')
            .eq('apartment_id', apartmentId)
            .eq('import_id', importResult.importId)
            .order('line_date', { ascending: true })
            .limit(1);
        if (lineFetchErr) throw Object.assign(new Error(lineFetchErr.message), { status: 500 });
        lineId = newLines?.[0]?.id || null;
    }

    await deleteTransactionMutation(service, apartmentId, { transaction_id: txnId });

    return { ok: true, line_id: lineId, import_id: importResult.importId };
}

async function setLedgerExclusionMutation(service, apartmentId, body) {
    const txnId = body.transaction_id;
    if (!txnId) throw Object.assign(new Error('transaction_id is required.'), { status: 400 });
    const excluded = body.excluded_from_ledger !== false;

    const { data: existing, error: fetchErr } = await service
        .from('transactions')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('id', txnId)
        .maybeSingle();
    if (fetchErr) throw Object.assign(new Error(fetchErr.message), { status: 500 });
    if (!existing) throw Object.assign(new Error('Transaction not found.'), { status: 404 });

    const payload = { ...existing, apartment_id: apartmentId, id: txnId, excluded_from_ledger: excluded };
    let { error } = await service.from('transactions').upsert(payload);
    if (error && /excluded_from_ledger/i.test(error.message)) {
        throw Object.assign(new Error('Run docs/scripts/sql/supabase_transactions_ledger_exclude.sql in Supabase first.'), { status: 500 });
    }
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true, excluded };
}

async function saveExpensePlanItemMutation(service, apartmentId, userId, body) {
    const row = {
        apartment_id: apartmentId,
        plan_date: body.plan_date || body.date,
        due_date: body.due_date || null,
        amount: roundMoney(body.amount),
        cat: body.cat || null,
        sub_category: body.sub_category || null,
        vendor_name: body.vendor_name || null,
        description: body.description || null,
        status: body.status || 'planned',
        recurring_id: body.recurring_id || null,
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
    };
    if (!row.plan_date) throw Object.assign(new Error('plan_date is required.'), { status: 400 });
    if (!(row.amount >= 0)) throw Object.assign(new Error('amount must be ≥ 0.'), { status: 400 });
    // If due_date column missing, retry without it.
    const save = async (payload) => {
        if (body.id) {
            return service
                .from('expense_plan_items')
                .update(payload)
                .eq('id', body.id)
                .eq('apartment_id', apartmentId)
                .select('*')
                .single();
        }
        return service
            .from('expense_plan_items')
            .insert({ ...payload, created_by: userId || null })
            .select('*')
            .single();
    };

    let { data, error } = await save(row);
    if (error && /due_date/i.test(error.message)) {
        const { due_date: _drop, ...withoutDue } = row;
        ({ data, error } = await save(withoutDue));
        if (!error) {
            return {
                item: data,
                warning: 'Run docs/scripts/sql/supabase_expense_plan_and_bills_entry.sql to enable due_date.',
            };
        }
    }
    if (error) throw Object.assign(new Error(error.message), { status: 400 });
    return { item: data };
}

async function deleteExpensePlanItemMutation(service, apartmentId, body) {
    const id = body.id || body.item_id;
    if (!id) throw Object.assign(new Error('id is required.'), { status: 400 });
    const { error } = await service
        .from('expense_plan_items')
        .delete()
        .eq('id', id)
        .eq('apartment_id', apartmentId);
    if (error) throw Object.assign(new Error(error.message), { status: 400 });
    return { ok: true, id };
}

async function saveExpensePlanRecurringMutation(service, apartmentId, userId, body) {
    const day = Math.min(28, Math.max(1, parseInt(body.day_of_month, 10) || 1));
    const dueDayRaw = body.due_day_of_month;
    const dueDay = dueDayRaw == null || dueDayRaw === ''
        ? day
        : Math.min(28, Math.max(1, parseInt(dueDayRaw, 10) || day));
    const row = {
        apartment_id: apartmentId,
        title: String(body.title || '').trim(),
        amount: roundMoney(body.amount),
        cat: body.cat || null,
        sub_category: body.sub_category || null,
        vendor_name: body.vendor_name || null,
        description: body.description || null,
        cadence: body.cadence || 'monthly',
        day_of_month: day,
        due_day_of_month: dueDay,
        start_date: body.start_date,
        end_date: body.end_date || null,
        active: body.active !== false,
        updated_at: new Date().toISOString(),
    };
    if (!row.title) throw Object.assign(new Error('title is required.'), { status: 400 });
    if (!row.start_date) throw Object.assign(new Error('start_date is required.'), { status: 400 });
    if (!['monthly', 'quarterly', 'yearly'].includes(row.cadence)) {
        throw Object.assign(new Error('cadence must be monthly, quarterly, or yearly.'), { status: 400 });
    }

    const save = async (payload) => {
        if (body.id) {
            return service
                .from('expense_plan_recurring')
                .update(payload)
                .eq('id', body.id)
                .eq('apartment_id', apartmentId)
                .select('*')
                .single();
        }
        return service
            .from('expense_plan_recurring')
            .insert({ ...payload, created_by: userId || null })
            .select('*')
            .single();
    };

    let { data, error } = await save(row);
    if (error && /due_day_of_month/i.test(error.message)) {
        const { due_day_of_month: _drop, ...withoutDue } = row;
        ({ data, error } = await save(withoutDue));
    }
    if (error) throw Object.assign(new Error(error.message), { status: 400 });
    return { recurring: data };
}

async function deleteExpensePlanRecurringMutation(service, apartmentId, body) {
    const id = body.id || body.recurring_id;
    if (!id) throw Object.assign(new Error('id is required.'), { status: 400 });
    const { error } = await service
        .from('expense_plan_recurring')
        .delete()
        .eq('id', id)
        .eq('apartment_id', apartmentId);
    if (error) throw Object.assign(new Error(error.message), { status: 400 });
    return { ok: true, id };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const body = req.body || await readJsonBody(req);
        const action = body.action;
        const billsEntryActions = new Set(['saveFinanceDocument', 'importFinanceDocuments']);
        const auth = billsEntryActions.has(action)
            ? await requireAnyApartmentPermission(req, body.apartment_id, ['accounts.edit', 'accounts.bills_entry'])
            : await requireApartmentPermission(req, body.apartment_id, 'accounts.edit');
        const { apartmentId, service, user } = auth;

        let result;
        switch (action) {
            case 'saveTransaction':
                result = await saveTransactionMutation(service, apartmentId, body);
                break;
            case 'saveFinanceDocument':
                result = await saveFinanceDocumentMutation(service, apartmentId, user?.id, body);
                break;
            case 'deleteFinanceDocument':
                result = await deleteFinanceDocumentMutation(service, apartmentId, body);
                break;
            case 'importFinanceDocuments':
                result = await importFinanceDocumentsMutation(service, apartmentId, user?.id, body);
                break;
            case 'linkFinanceDocuments':
                result = await linkFinanceDocumentsMutation(service, apartmentId, body);
                break;
            case 'syncFinanceDocumentCategories':
                result = await syncFinanceDocumentCategoriesMutation(service, apartmentId, body);
                break;
            case 'unlinkFinanceDocuments':
                result = await unlinkFinanceDocumentsMutation(service, apartmentId, body);
                break;
            case 'setCashFloatFlag':
                result = await setCashFloatFlagMutation(service, apartmentId, body);
                break;
            case 'saveCashFloatOpening':
                result = await saveCashFloatOpeningMutation(service, apartmentId, body);
                break;
            case 'saveExpensePlanItem':
                result = await saveExpensePlanItemMutation(service, apartmentId, user?.id, body);
                break;
            case 'deleteExpensePlanItem':
                result = await deleteExpensePlanItemMutation(service, apartmentId, body);
                break;
            case 'saveExpensePlanRecurring':
                result = await saveExpensePlanRecurringMutation(service, apartmentId, user?.id, body);
                break;
            case 'deleteExpensePlanRecurring':
                result = await deleteExpensePlanRecurringMutation(service, apartmentId, body);
                break;
            case 'deleteTransaction':
                result = await deleteTransactionMutation(service, apartmentId, body);
                break;
            case 'deleteTransactions':
                result = await deleteTransactionsMutation(service, apartmentId, body);
                break;
            case 'saveBankOpeningBalance':
                result = await saveBankOpeningBalanceMutation(service, apartmentId, body);
                break;
            case 'importBankStatement':
                result = await importBankStatementMutation(service, apartmentId, user?.id, body);
                break;
            case 'matchBankLine':
                result = await updateBankLineMatchMutation(service, apartmentId, user?.id, body, 'match');
                break;
            case 'unmatchBankLine':
                result = await updateBankLineMatchMutation(service, apartmentId, user?.id, body, 'unmatch');
                break;
            case 'unmatchBankLines':
                result = await bulkUpdateBankLineMatchMutation(service, apartmentId, user?.id, body, 'unmatch');
                break;
            case 'ignoreBankLine':
                result = await updateBankLineMatchMutation(service, apartmentId, user?.id, body, 'ignore');
                break;
            case 'updateBankStatementLine':
                result = await updateBankStatementLineMutation(service, apartmentId, body);
                break;
            case 'deleteBankStatementLines':
                result = await deleteBankStatementLinesMutation(service, apartmentId, body);
                break;
            case 'clearBankStatementData':
                result = await clearBankStatementDataMutation(service, apartmentId);
                break;
            case 'reorderBankStatementLines':
                result = await reorderBankStatementLinesMutation(service, apartmentId, body);
                break;
            case 'recalculateBankStatementBalances':
                result = await recalculateBankStatementBalancesMutation(service, apartmentId);
                break;
            case 'createTxnFromBankLine':
                result = await createTxnFromBankLineMutation(service, apartmentId, body);
                break;
            case 'createTxnsFromBankLines':
                result = await createTxnsFromBankLinesMutation(service, apartmentId, user?.id, body);
                break;
            case 'createLedgerFromBankLineAuto':
                result = await createLedgerFromBankLineAutoMutation(service, apartmentId, body);
                break;
            case 'saveBankClassificationRule':
                result = await saveBankClassificationRuleMutation(service, apartmentId, body);
                break;
            case 'deleteBankClassificationRule':
                result = await deleteBankClassificationRuleMutation(service, apartmentId, body);
                break;
            case 'listBankClassificationRules':
                result = await listBankClassificationRulesMutation(service, apartmentId);
                break;
            case 'previewBankClassificationRules':
                result = await previewBankClassificationRulesMutation(service, apartmentId);
                break;
            case 'bulkUpdateTransactions':
                result = await bulkUpdateTransactionsMutation(service, apartmentId, body);
                break;
            case 'setLedgerExclusion':
                result = await setLedgerExclusionMutation(service, apartmentId, body);
                break;
            case 'returnLedgerTxnToStatement':
                result = await returnLedgerTxnToStatementMutation(service, apartmentId, user?.id, body);
                break;
            default:
                return res.status(400).json({ error: 'Unknown finance action.' });
        }

        return res.status(200).json(result || { ok: true });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Finance mutation failed.' });
    }
}
