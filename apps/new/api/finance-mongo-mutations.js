/**
 * Finance-New Mongo mutations — classic action names from finance-mutations.js
 * plus tableWrite for billing/helpers that used supabase.from directly.
 */
import crypto from 'node:crypto';
import {
    requireAnyApartmentPermission,
    requireApartmentPermission,
    requireApartmentCrud,
} from '../../../packages/server/serverAuth.js';
import { readJsonBody } from '../../../packages/server/vercelRequest.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import { logMongoApi } from '../../../packages/server/mongoLog.js';
import {
    isR2Configured,
    r2PutObject,
    r2DeleteObjects,
    buildFinanceDocObjectKey,
    extForRecordMime,
    attachmentObjectKey,
    isAllowedFinanceDocObjectKey,
} from '../../../packages/server/r2Storage.js';

const VIEW_PERMS = ['accounts.view', 'accounts.edit', 'accounts.bills_entry'];
const BILLS_WRITE = ['accounts.edit', 'accounts.bills_entry'];
const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;
const apt = (apartmentId) => ({ apartment_id: apartmentId });
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function normalizeKeptAttachments(kept = []) {
    return (kept || [])
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
                    uploadedAt: entry.uploadedAt || nowIso(),
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
                uploadedAt: nowIso(),
                purpose: 'bill',
            };
        })
        .filter(Boolean);
}

async function uploadFinanceDocFilesToR2(apartmentId, files = [], { kind } = {}) {
    if (!files.length) return [];
    if (!isR2Configured()) {
        throw Object.assign(
            new Error('Object storage is not configured (set R2 credentials and bucket).'),
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
            orgName: apartmentId,
            kind: kind === 'IN' ? 'IN' : 'OUT',
            mimeOrExt: mime,
        });
        // eslint-disable-next-line no-await-in-loop
        await r2PutObject({ key, body, contentType: mime });
        const purpose = String(file.purpose || '').toLowerCase() === 'payment' ? 'payment' : 'bill';
        uploaded.push({
            key,
            contentType: mime,
            originalName: String(file.name || '').slice(0, 512),
            bytes: body.length,
            uploadedAt: nowIso(),
            purpose,
        });
    }
    return uploaded;
}

async function ensureConfig(db, apartmentId) {
    const col = db.collection('finance_config');
    let cfg = await col.findOne(apt(apartmentId));
    if (!cfg) {
        cfg = {
            _id: apartmentId,
            apartment_id: apartmentId,
            bankAccount: null,
            ledgerBalance: { needsRecalc: false, dirtyFromDate: null, lastRecalcAt: null },
            vendors: [],
            subCategories: [],
            chargeHeads: [],
            penaltyRules: [],
            classificationRules: [],
            chartOfAccounts: [],
            expensePlanItems: [],
            expensePlanRecurring: [],
            _schema: 'v2',
            _remodeledAt: new Date(),
        };
        await col.insertOne(cfg);
    }
    return cfg;
}

async function saveConfig(db, apartmentId, patch) {
    await ensureConfig(db, apartmentId);
    await db.collection('finance_config').updateOne(apt(apartmentId), {
        $set: { ...patch, _remodeledAt: new Date(), _schema: 'v2' },
    });
    return db.collection('finance_config').findOne(apt(apartmentId));
}

const dayKey = (value) => {
    const raw = String(value || '');
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : raw.slice(0, 10);
};

const minDay = (a, b) => {
    if (!a) return b || null;
    if (!b) return a;
    return a < b ? a : b;
};

const txnMovement = (t) => {
    const amt = parseFloat(t.amount) || 0;
    return t.type === 'IN' ? amt : -amt;
};

const isBankTxn = (t) => String(t?.wallet || '').toUpperCase() === 'BANK';
const isActiveLedgerTxn = (t) => !t?.excluded_from_ledger;

async function markLedgerBalanceDirty(db, apartmentId, fromDate = null) {
    const cfg = await ensureConfig(db, apartmentId);
    const prev = cfg.ledgerBalance || {};
    const next = {
        needsRecalc: true,
        dirtyFromDate: minDay(prev.dirtyFromDate || null, fromDate ? dayKey(fromDate) : null),
        lastRecalcAt: prev.lastRecalcAt || null,
        updated_at: nowIso(),
    };
    await saveConfig(db, apartmentId, { ledgerBalance: next });
    return next;
}

async function loadBankLedgerChronological(db, apartmentId) {
    const [entries, imports] = await Promise.all([
        db.collection('ledger_entries').find({
            ...apt(apartmentId),
            wallet: 'BANK',
            excluded_from_ledger: { $ne: true },
        }).toArray(),
        db.collection('bank_imports').find(apt(apartmentId)).toArray(),
    ]);
    const lineByTxn = new Map();
    for (const imp of imports) {
        for (const line of imp.lines || []) {
            if (line.transaction_id) lineByTxn.set(String(line.transaction_id), line);
        }
    }
    const sortDay = (t) => {
        const line = lineByTxn.get(String(t._id || t.id));
        return dayKey(line?.line_date || t.date);
    };
    entries.sort((a, b) => {
        const dayCmp = sortDay(a).localeCompare(sortDay(b));
        if (dayCmp) return dayCmp;
        const lineA = lineByTxn.get(String(a._id || a.id));
        const lineB = lineByTxn.get(String(b._id || b.id));
        if (lineA && lineB) {
            const orderCmp = (lineA.line_order || 0) - (lineB.line_order || 0);
            if (orderCmp) return orderCmp;
            const ocrCmp = (lineA.source_row_index || 0) - (lineB.source_row_index || 0);
            if (ocrCmp) return ocrCmp;
        } else if (lineA && !lineB) return -1;
        else if (!lineA && lineB) return 1;
        return String(a._id || a.id).localeCompare(String(b._id || b.id));
    });
    return { entries, lineByTxn, sortDay };
}

/**
 * Persist running_balance_after on BANK ledger rows.
 * Incremental: seed from last trusted balance before dirtyFromDate, then rewrite forward.
 */
async function recalculateLedgerBalances(db, apartmentId, body = {}) {
    const cfg = await ensureConfig(db, apartmentId);
    const openingAmt = cfg.bankAccount?.opening_balance;
    const openingDate = dayKey(cfg.bankAccount?.opening_balance_date);
    if (openingAmt == null || Number.isNaN(parseFloat(openingAmt))) {
        throw Object.assign(new Error('Set bank opening balance before recalculating ledger balances.'), { status: 400 });
    }

    const full = body.full === true || !cfg.ledgerBalance?.dirtyFromDate;
    const dirtyFrom = full
        ? (openingDate || null)
        : minDay(cfg.ledgerBalance?.dirtyFromDate, openingDate);

    const { entries, sortDay } = await loadBankLedgerChronological(db, apartmentId);
    let running = parseFloat(openingAmt);
    let startIdx = 0;

    if (!full && dirtyFrom) {
        // Seed from last row strictly before dirtyFrom that already has a balance.
        for (let i = 0; i < entries.length; i += 1) {
            const day = sortDay(entries[i]);
            if (openingDate && day < openingDate) continue;
            if (day < dirtyFrom) {
                if (entries[i].running_balance_after != null
                    && !Number.isNaN(parseFloat(entries[i].running_balance_after))) {
                    running = parseFloat(entries[i].running_balance_after);
                } else {
                    running += txnMovement(entries[i]);
                }
                startIdx = i + 1;
                continue;
            }
            startIdx = i;
            break;
        }
    }

    let updated = 0;
    const ops = [];
    for (let i = 0; i < entries.length; i += 1) {
        const t = entries[i];
        const day = sortDay(t);
        if (openingDate && day < openingDate) {
            if (t.running_balance_after != null) {
                ops.push({
                    updateOne: {
                        filter: { _id: t._id },
                        update: { $set: { running_balance_after: null, updated_at: nowIso() } },
                    },
                });
                updated += 1;
            }
            continue;
        }
        if (i < startIdx) continue;
        running += txnMovement(t);
        const next = roundMoney(running);
        if (t.running_balance_after == null || Math.abs(parseFloat(t.running_balance_after) - next) > 0.001) {
            ops.push({
                updateOne: {
                    filter: { _id: t._id },
                    update: { $set: { running_balance_after: next, updated_at: nowIso() } },
                },
            });
            updated += 1;
        } else {
            // Keep running in sync even if write skipped
            running = parseFloat(t.running_balance_after);
        }
    }

    if (ops.length) {
        // Chunk bulkWrite to avoid huge payloads
        for (let i = 0; i < ops.length; i += 500) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('ledger_entries').bulkWrite(ops.slice(i, i + 500), { ordered: false });
        }
    }

    // Clear balances on non-BANK / excluded rows that still have a stale value
    await db.collection('ledger_entries').updateMany(
        {
            ...apt(apartmentId),
            running_balance_after: { $ne: null },
            $or: [
                { wallet: { $ne: 'BANK' } },
                { excluded_from_ledger: true },
            ],
        },
        { $set: { running_balance_after: null, updated_at: nowIso() } },
    );

    const ledgerBalance = {
        needsRecalc: false,
        dirtyFromDate: null,
        lastRecalcAt: nowIso(),
        closing: roundMoney(running),
        updated_at: nowIso(),
    };
    const config = await saveConfig(db, apartmentId, { ledgerBalance });
    return {
        ok: true,
        updated,
        fromDate: dirtyFrom,
        full,
        closing: ledgerBalance.closing,
        ledgerBalance,
        config: stripMongo(config),
    };
}

function titleCaseVendorName(name) {
    const ACRONYMS = new Set(['llp', 'pvt', 'ltd', 'llc', 'opc', 'gst', 'dg', 'upi', 'neft', 'rtgs', 'imps', 'bescom', 'bwssb', 'act']);
    const raw = String(name || '').trim().replace(/\s+/g, ' ');
    if (!raw) return '';
    return raw.split(/(\s+|-)/).map((part) => {
        if (!part || /^\s+$/.test(part) || part === '-') return part;
        const lower = part.toLowerCase();
        const bare = lower.replace(/\./g, '');
        if (ACRONYMS.has(bare)) return bare.toUpperCase();
        if (/^\d+[a-z]+$/i.test(part)) {
            return part.replace(/^(\d+)([a-z]+)$/i, (_, n, letters) => n + letters.toUpperCase());
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
}

async function touchVendor(db, apartmentId, name) {
    if (!name) return;
    const titled = titleCaseVendorName(name);
    if (!titled) return;
    const cfg = await ensureConfig(db, apartmentId);
    const list = [...(cfg.vendors || [])];
    const idx = list.findIndex((v) => String(v.name || '').toLowerCase() === titled.toLowerCase());
    if (idx >= 0) {
        list[idx] = {
            ...list[idx],
            name: titled,
            use_count: (list[idx].use_count || 0) + 1,
            last_used_at: nowIso(),
        };
    } else {
        list.push({
            id: uid(),
            apartment_id: apartmentId,
            name: titled,
            notes: null,
            contact_phone: null,
            contact_email: null,
            use_count: 1,
            last_used_at: nowIso(),
        });
    }
    await saveConfig(db, apartmentId, { vendors: list });
}

function stripMongo(doc) {
    if (!doc) return doc;
    const { _schema, _remodeledAt, _migratedAt, ...rest } = doc;
    return rest;
}

async function findLine(db, apartmentId, lineId) {
    const imports = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    for (const imp of imports) {
        const line = (imp.lines || []).find((l) => String(l.id || l._id) === String(lineId));
        if (line) return { imp, line };
    }
    return null;
}

async function updateLine(db, apartmentId, lineId, patch) {
    const hit = await findLine(db, apartmentId, lineId);
    if (!hit) throw Object.assign(new Error('Bank line not found.'), { status: 404 });
    const lines = (hit.imp.lines || []).map((l) => (
        String(l.id || l._id) === String(lineId) ? { ...l, ...patch } : l
    ));
    await db.collection('bank_imports').updateOne(
        { _id: hit.imp._id },
        { $set: { lines, lineCount: lines.length, _remodeledAt: new Date() } },
    );
    return lines.find((l) => String(l.id || l._id) === String(lineId));
}

async function saveTransaction(db, apartmentId, body) {
    const txn = body.transaction || {};
    const id = txn.id || uid();
    const amount = roundMoney(txn.amount);
    if (!(amount > 0)) throw Object.assign(new Error('Enter a valid amount.'), { status: 400 });
    if (!txn.date) throw Object.assign(new Error('Date is required.'), { status: 400 });
    const existing = await db.collection('ledger_entries').findOne({ _id: String(id), ...apt(apartmentId) });
    const doc = {
        ...(existing || {}),
        ...txn,
        _id: String(id),
        id,
        apartment_id: apartmentId,
        type: txn.type === 'IN' ? 'IN' : 'OUT',
        wallet: (txn.wallet || 'CASH').toUpperCase() === 'BANK' ? 'BANK' : 'CASH',
        amount,
        date: String(txn.date).slice(0, 10),
        voucherIds: existing?.voucherIds || [],
        bankLineRefs: existing?.bankLineRefs || [],
        maintenancePayments: Array.isArray(body.allocations)
            ? body.allocations.filter((a) => parseFloat(a.amount || 0) > 0).map((a) => ({
                allocationId: uid(),
                invoiceId: a.invoice_id,
                amount: roundMoney(a.amount),
            }))
            : (existing?.maintenancePayments || []),
        _schema: 'v2',
        _remodeledAt: new Date(),
        updated_at: nowIso(),
    };
    if (!existing) doc.created_at = nowIso();
    await db.collection('ledger_entries').replaceOne({ _id: String(id) }, doc, { upsert: true });

    // Sync allocations onto dues invoices
    if (txn.cat === 'Maintenance Collection' && Array.isArray(body.allocations)) {
        for (const a of body.allocations) {
            if (!(parseFloat(a.amount || 0) > 0) || !a.invoice_id) continue;
            await db.collection('dues_invoices').updateOne(
                { _id: String(a.invoice_id), ...apt(apartmentId) },
                {
                    $pull: { payments: { transaction_id: id } },
                },
            );
            await db.collection('dues_invoices').updateOne(
                { _id: String(a.invoice_id), ...apt(apartmentId) },
                {
                    $push: {
                        payments: {
                            id: uid(),
                            transaction_id: id,
                            amount: roundMoney(a.amount),
                            created_at: nowIso(),
                        },
                    },
                },
            );
        }
    }

    if (doc.vendor_name) await touchVendor(db, apartmentId, doc.vendor_name);

    // Only amount / type / wallet / date / exclusion change running balances.
    // Description, category, vendor, etc. must not force Recalculate.
    const balanceSnap = (t) => (t ? {
        amount: roundMoney(t.amount),
        type: t.type === 'IN' ? 'IN' : 'OUT',
        wallet: String(t.wallet || 'CASH').toUpperCase() === 'BANK' ? 'BANK' : 'CASH',
        date: String(t.date || '').slice(0, 10),
        excluded_from_ledger: !!t.excluded_from_ledger,
    } : null);
    const beforeBal = balanceSnap(existing);
    const afterBal = balanceSnap(doc);
    const balanceFieldsChanged = !beforeBal
        || ['amount', 'type', 'wallet', 'date', 'excluded_from_ledger']
            .some((k) => beforeBal[k] !== afterBal[k]);
    const touchesBankLedger = isBankTxn(doc) || isBankTxn(existing);
    let ledgerBalance = null;
    if (balanceFieldsChanged && touchesBankLedger) {
        ledgerBalance = await markLedgerBalanceDirty(
            db,
            apartmentId,
            minDay(existing?.date, doc.date),
        );
    }
    return {
        ok: true,
        transaction: stripMongo(doc),
        entry: stripMongo(doc),
        ledgerBalance,
    };
}

async function deleteTransaction(db, apartmentId, body) {
    const id = body.transaction_id || body.id;
    if (!id) throw Object.assign(new Error('transaction_id required.'), { status: 400 });
    const existing = await db.collection('ledger_entries').findOne({ _id: String(id), ...apt(apartmentId) });
    await db.collection('vouchers').updateMany(
        { ...apt(apartmentId), $or: [{ transaction_id: id }, { ledgerEntryId: id }] },
        { $set: { transaction_id: null, ledgerEntryId: null, status: 'paid' } },
    );
    const imports = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    for (const imp of imports) {
        let changed = false;
        const lines = (imp.lines || []).map((l) => {
            if (String(l.transaction_id) !== String(id)) return l;
            changed = true;
            return {
                ...l, transaction_id: null, match_status: 'UNMATCHED', matched_at: null, matched_by: null,
            };
        });
        if (changed) {
            await db.collection('bank_imports').updateOne({ _id: imp._id }, { $set: { lines } });
        }
    }
    await db.collection('dues_invoices').updateMany(
        apt(apartmentId),
        { $pull: { payments: { transaction_id: id } } },
    );
    await db.collection('ledger_entries').deleteOne({ _id: String(id), ...apt(apartmentId) });
    let ledgerBalance = null;
    if (existing && isBankTxn(existing) && isActiveLedgerTxn(existing)) {
        ledgerBalance = await markLedgerBalanceDirty(db, apartmentId, existing.date);
    }
    return { ok: true, ledgerBalance };
}

async function deleteTransactions(db, apartmentId, body) {
    const ids = [...new Set((body.transaction_ids || []).filter(Boolean))];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await deleteTransaction(db, apartmentId, { transaction_id: id });
    }
    return { ok: true, deleted: ids.length };
}

function resolveVoucherStatus(doc, transactionId) {
    if (doc.status === 'void') return 'void';
    if (transactionId) return 'linked';
    if (['paid', 'unpaid', 'linked'].includes(doc.status)) return doc.status;
    return 'unpaid';
}

function paymentNotesFromLedgerTxn(txn) {
    if (!txn) return null;
    const wallet = String(txn.wallet || '').toUpperCase();
    const type = txn.type;
    const cat = String(txn.cat || '');
    const ref = String(txn.bank_reference || txn.cheque_no || '').trim();
    const date = String(txn.date || '').slice(0, 10);
    const paidOn = date ? `\nPaid on: ${date}` : '';
    const hay = `${ref} ${txn.description || ''}`.toLowerCase();
    const fromWallet = wallet !== 'BANK' || (cat === 'Petty Cash' && type === 'IN');
    if (fromWallet) return `Payment: Cash${paidOn}`;
    if (/upi|neft|imps|rtgs|online/.test(hay)) {
        return `Online: ${ref || String(txn.description || 'Bank').slice(0, 48)}${paidOn}`;
    }
    if (ref) return `Cheque: ${ref}${paidOn}`;
    if (wallet === 'BANK') return `Online: ${String(txn.description || 'Bank').slice(0, 48)}${paidOn}`;
    return `Payment: Cash${paidOn}`;
}

function notesNeedPaymentMode(notes) {
    const text = String(notes || '').trim();
    if (!text) return true;
    if (/Payment:\s*Unpaid/i.test(text)) return true;
    if (/^Cheque:\s*/i.test(text) || /^Online:\s*/i.test(text) || /Payment:\s*Cash/i.test(text)) return false;
    return true;
}

async function saveFinanceDocument(db, apartmentId, userId, body) {
    const raw = body.document || {};
    const id = raw.id || uid();
    const kind = raw.kind === 'IN' ? 'IN' : 'OUT';
    const amount = roundMoney(raw.amount);
    if (!(amount > 0)) throw Object.assign(new Error('Enter a valid amount.'), { status: 400 });
    if (!raw.doc_date && !raw.date) throw Object.assign(new Error('Date is required.'), { status: 400 });
    const existing = await db.collection('vouchers').findOne({ _id: String(id), ...apt(apartmentId) });
    const prevTxn = existing?.transaction_id || existing?.ledgerEntryId || null;
    const transactionId = raw.transaction_id || raw.ledgerEntryId || null;
    const kept = normalizeKeptAttachments(
        body.keepAttachments || body.keepAttachmentPaths || raw.attachment_urls || existing?.attachment_urls || [],
    );
    let uploaded = [];
    if (body.newAttachmentFiles?.length) {
        uploaded = await uploadFinanceDocFilesToR2(apartmentId, body.newAttachmentFiles, { kind });
    }
    const removeList = body.removeAttachments || [];
    const removeKeys = removeList
        .map((a) => (a && typeof a === 'object' ? a.key : attachmentObjectKey(a)))
        .filter((k) => k && isAllowedFinanceDocObjectKey(k));
    if (removeKeys.length && isR2Configured()) {
        try { await r2DeleteObjects(removeKeys); } catch { /* keep save even if R2 delete fails */ }
    }
    const doc = {
        ...(existing || {}),
        ...raw,
        _id: String(id),
        id,
        apartment_id: apartmentId,
        kind,
        doc_date: String(raw.doc_date || raw.date).slice(0, 10),
        amount,
        transaction_id: transactionId,
        ledgerEntryId: transactionId,
        status: resolveVoucherStatus(raw, transactionId),
        attachment_urls: [...kept, ...uploaded],
        source: raw.source === 'excel' ? 'excel' : (raw.source || 'manual'),
        vendor_name: raw.vendor_name ? titleCaseVendorName(raw.vendor_name) : (raw.vendor_name ?? existing?.vendor_name ?? null),
        updated_at: nowIso(),
        _schema: 'v2',
        _remodeledAt: new Date(),
    };
    if (!existing) {
        doc.created_at = nowIso();
        doc.created_by = userId || null;
    }
    await db.collection('vouchers').replaceOne({ _id: String(id) }, doc, { upsert: true });
    if (prevTxn && prevTxn !== transactionId) {
        await db.collection('ledger_entries').updateOne({ _id: String(prevTxn) }, { $pull: { voucherIds: id } });
    }
    if (transactionId) {
        await db.collection('ledger_entries').updateOne({ _id: String(transactionId) }, { $addToSet: { voucherIds: id } });
    }
    if (doc.vendor_name) await touchVendor(db, apartmentId, doc.vendor_name);
    return { ok: true, document: stripMongo(doc) };
}

async function deleteFinanceDocument(db, apartmentId, body) {
    const id = body.document_id || body.id;
    const existing = await db.collection('vouchers').findOne({ _id: String(id), ...apt(apartmentId) });
    if (!existing) throw Object.assign(new Error('Voucher not found.'), { status: 404 });
    const txnId = existing.transaction_id || existing.ledgerEntryId;
    if (txnId) {
        await db.collection('ledger_entries').updateOne({ _id: String(txnId) }, { $pull: { voucherIds: id } });
    }
    await db.collection('vouchers').deleteOne({ _id: String(id) });
    return { ok: true };
}

async function linkFinanceDocuments(db, apartmentId, body) {
    const txnId = body.transaction_id;
    const ids = body.document_ids || [];
    if (!txnId || !ids.length) throw Object.assign(new Error('transaction_id and document_ids required.'), { status: 400 });
    const txn = await db.collection('ledger_entries').findOne({ _id: String(txnId), ...apt(apartmentId) });
    if (!txn) throw Object.assign(new Error('Ledger row not found.'), { status: 404 });
    const inferredNotes = paymentNotesFromLedgerTxn(txn);
    const documents = [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await db.collection('vouchers').findOne({ _id: String(id), ...apt(apartmentId) });
        if (!existing) continue;
        const next = {
            ...existing,
            transaction_id: txnId,
            ledgerEntryId: txnId,
            status: 'linked',
            updated_at: nowIso(),
        };
        if (inferredNotes && notesNeedPaymentMode(existing.notes)) {
            next.notes = inferredNotes;
        } else if (inferredNotes && existing.notes && !/Paid on:/i.test(String(existing.notes))) {
            const date = String(txn.date || '').slice(0, 10);
            if (date) next.notes = `${String(existing.notes).trim()}\nPaid on: ${date}`;
        }
        // eslint-disable-next-line no-await-in-loop
        await db.collection('vouchers').replaceOne({ _id: String(id) }, next);
        documents.push(stripMongo(next));
    }
    await db.collection('ledger_entries').updateOne(
        { _id: String(txnId) },
        { $addToSet: { voucherIds: { $each: ids.map(String) } } },
    );
    if (body.cash_desk_deposit != null) {
        await db.collection('ledger_entries').updateOne(
            { _id: String(txnId) },
            { $set: { cash_desk_deposit: body.cash_desk_deposit === true } },
        );
    }
    const transaction = await db.collection('ledger_entries').findOne({ _id: String(txnId) });
    return {
        ok: true, documents, count: documents.length, transaction: stripMongo(transaction), cash_desk_deposit: body.cash_desk_deposit,
    };
}

async function unlinkFinanceDocuments(db, apartmentId, body) {
    const ids = body.document_ids || [];
    const documents = [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await db.collection('vouchers').findOne({ _id: String(id), ...apt(apartmentId) });
        if (!existing) continue;
        const txnId = existing.transaction_id || existing.ledgerEntryId;
        existing.transaction_id = null;
        existing.ledgerEntryId = null;
        existing.status = 'paid';
        // eslint-disable-next-line no-await-in-loop
        await db.collection('vouchers').replaceOne({ _id: String(id) }, existing);
        if (txnId) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('ledger_entries').updateOne({ _id: String(txnId) }, { $pull: { voucherIds: id } });
        }
        documents.push(stripMongo(existing));
    }
    return { ok: true, documents, count: documents.length };
}

async function importFinanceDocuments(db, apartmentId, userId, body) {
    const rows = body.rows || [];
    const documents = [];
    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        const res = await saveFinanceDocument(db, apartmentId, userId, {
            document: {
                ...row,
                doc_date: row.doc_date || row.date,
                source: 'excel',
                source_file: body.source_file || null,
                status: /paid/i.test(String(row.notes || '')) ? 'paid' : 'unpaid',
            },
        });
        documents.push(res.document);
    }
    return { ok: true, count: documents.length, documents };
}

async function syncFinanceDocumentCategories(db, apartmentId, body) {
    const ids = body.document_ids || [];
    const documents = [];
    const transactions = [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await db.collection('vouchers').findOne({ _id: String(id), ...apt(apartmentId) });
        if (!doc?.transaction_id) continue;
        // eslint-disable-next-line no-await-in-loop
        const txn = await db.collection('ledger_entries').findOne({ _id: String(doc.transaction_id) });
        if (!txn) continue;
        const patch = { cat: doc.cat || txn.cat, sub_category: doc.sub_category || txn.sub_category };
        // eslint-disable-next-line no-await-in-loop
        await db.collection('ledger_entries').updateOne({ _id: txn._id }, { $set: patch });
        documents.push(stripMongo(doc));
        transactions.push(stripMongo({ ...txn, ...patch }));
    }
    return {
        ok: true, documents, transactions, count: documents.length, ledger_updated: transactions.length,
    };
}

async function setCashFloatFlag(db, apartmentId, body) {
    const id = body.transaction_id;
    const isCashFloat = body.is_cash_float === true;
    const patch = { is_cash_float: isCashFloat };
    if (isCashFloat && body.set_petty_cash_cat !== false) patch.cat = 'Petty Cash';
    if (Object.prototype.hasOwnProperty.call(body, 'exclude_from_cash_float')) {
        patch.exclude_from_cash_float = body.exclude_from_cash_float === true;
    } else {
        patch.exclude_from_cash_float = !isCashFloat;
    }
    await db.collection('ledger_entries').updateOne({ _id: String(id), ...apt(apartmentId) }, { $set: patch });
    const transaction = await db.collection('ledger_entries').findOne({ _id: String(id) });
    return { ok: true, transaction: stripMongo(transaction) };
}

async function saveCashFloatOpening(db, apartmentId, body) {
    const cfg = await ensureConfig(db, apartmentId);
    const bank = { ...(cfg.bankAccount || {}), ...(body.bank || {}) };
    bank.apartment_id = apartmentId;
    bank.id = bank.id || uid();
    bank.cash_float_opening_balance = body.amount == null ? null : parseFloat(body.amount);
    bank.cash_float_opening_date = body.amount == null ? null : body.date;
    bank.updated_at = nowIso();
    const config = await saveConfig(db, apartmentId, { bankAccount: bank });
    return {
        ok: true,
        bankAccount: bank,
        amount: bank.cash_float_opening_balance,
        date: bank.cash_float_opening_date,
        config,
    };
}

async function saveBankOpeningBalance(db, apartmentId, body) {
    if (!body.date) throw Object.assign(new Error('Enter the opening balance date.'), { status: 400 });
    if (body.amount == null || Number.isNaN(parseFloat(body.amount))) {
        throw Object.assign(new Error('Enter the opening balance amount.'), { status: 400 });
    }
    const cfg = await ensureConfig(db, apartmentId);
    const bank = { ...(cfg.bankAccount || {}), ...(body.bank || {}) };
    bank.apartment_id = apartmentId;
    bank.id = bank.id || uid();
    bank.bank_name = bank.bank_name || 'Bank account';
    bank.opening_balance = parseFloat(body.amount);
    bank.opening_balance_date = body.date;
    bank.updated_at = nowIso();
    await saveConfig(db, apartmentId, { bankAccount: bank });
    await markLedgerBalanceDirty(db, apartmentId, body.date);
    const ledgerResult = await recalculateLedgerBalances(db, apartmentId, { full: true });
    await recalculateBankStatementBalances(db, apartmentId);
    return { ok: true, ledgerBalance: ledgerResult.ledgerBalance, config: ledgerResult.config };
}

async function recalculateBankStatementBalances(db, apartmentId) {
    const cfg = await ensureConfig(db, apartmentId);
    const openingAmount = cfg.bankAccount?.opening_balance;
    const openingDate = cfg.bankAccount?.opening_balance_date
        ? String(cfg.bankAccount.opening_balance_date).slice(0, 10)
        : null;
    const hasOpening = openingAmount != null && openingAmount !== '' && !Number.isNaN(parseFloat(openingAmount));
    let running = hasOpening ? parseFloat(openingAmount) : 0;

    const imports = await db.collection('bank_imports').find(apt(apartmentId)).sort({ created_at: 1 }).toArray();
    const importMeta = new Map(imports.map((imp) => [String(imp._id), imp]));

    // Flatten all lines; sort like client compareLineOrder (manual line_order wins same-day).
    const all = [];
    for (const imp of imports) {
        for (const line of imp.lines || []) {
            all.push({ impId: imp._id, line });
        }
    }
    const importKey = (impId) => {
        const imp = importMeta.get(String(impId));
        if (!imp) return '';
        if (imp.created_at) return String(imp.created_at);
        if (imp.file_name) return String(imp.file_name);
        return String(impId);
    };
    all.sort((a, b) => {
        const d = String(a.line.line_date || '').localeCompare(String(b.line.line_date || ''));
        if (d) return d;
        const aManual = String(a.line.order_source || '').toLowerCase() === 'manual';
        const bManual = String(b.line.order_source || '').toLowerCase() === 'manual';
        if (aManual || bManual) {
            const byOrder = (a.line.line_order ?? 0) - (b.line.line_order ?? 0);
            if (byOrder) return byOrder;
            return String(a.line.id || a.line._id || '').localeCompare(String(b.line.id || b.line._id || ''));
        }
        if (String(a.impId) === String(b.impId)) {
            const byOrder = (a.line.line_order ?? 0) - (b.line.line_order ?? 0);
            if (byOrder) return byOrder;
            const byOcr = (a.line.source_row_index ?? 0) - (b.line.source_row_index ?? 0);
            if (byOcr) return byOcr;
            return String(a.line.id || '').localeCompare(String(b.line.id || ''));
        }
        const byImport = importKey(a.impId).localeCompare(importKey(b.impId));
        if (byImport) return byImport;
        const byOcr = (a.line.source_row_index ?? 0) - (b.line.source_row_index ?? 0);
        if (byOcr) return byOcr;
        const byOrder = (a.line.line_order ?? 0) - (b.line.line_order ?? 0);
        if (byOrder) return byOrder;
        return String(a.line.id || '').localeCompare(String(b.line.id || ''));
    });

    const byImp = new Map();
    for (const { impId, line } of all) {
        const onOrAfterOpening = !openingDate || String(line.line_date || '') >= openingDate;
        let computed = null;
        if (hasOpening && onOrAfterOpening) {
            running += (parseFloat(line.credit) || 0) - (parseFloat(line.debit) || 0);
            computed = running;
        }
        const next = { ...line, computed_balance: computed };
        if (!byImp.has(String(impId))) byImp.set(String(impId), []);
        byImp.get(String(impId)).push(next);
    }
    for (const imp of imports) {
        const updatedIds = new Map((byImp.get(String(imp._id)) || []).map((l) => [String(l.id || l._id), l]));
        const lines = (imp.lines || []).map((l) => updatedIds.get(String(l.id || l._id)) || l);
        // eslint-disable-next-line no-await-in-loop
        await db.collection('bank_imports').updateOne({ _id: imp._id }, { $set: { lines } });
    }
    return { ok: true };
}

async function importBankStatement(db, apartmentId, userId, body) {
    const linesIn = body.lines || [];
    if (!linesIn.length) return { importId: null, count: 0 };
    const importId = uid();
    const dates = linesIn.map((l) => l.line_date).filter(Boolean).sort();
    const existing = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    const maxOrderByDate = new Map();
    for (const imp of existing) {
        for (const row of imp.lines || []) {
            const key = row.line_date;
            maxOrderByDate.set(key, Math.max(maxOrderByDate.get(key) ?? -1, row.line_order ?? 0));
        }
    }
    const lines = linesIn.map((line) => {
        const date = line.line_date || '';
        const localOrder = line.line_order ?? 0;
        const offset = date && maxOrderByDate.has(date) ? maxOrderByDate.get(date) + 1 : 0;
        return {
            id: uid(),
            line_date: line.line_date,
            description: line.description || null,
            debit: line.debit || 0,
            credit: line.credit || 0,
            balance: line.balance ?? null,
            line_order: offset + localOrder,
            source_row_index: line.source_row_index ?? null,
            order_source: line.order_source || 'auto',
            match_status: 'UNMATCHED',
            transaction_id: null,
        };
    });
    await db.collection('bank_imports').insertOne({
        _id: importId,
        id: importId,
        apartment_id: apartmentId,
        bank_account_id: body.bank_account_id || null,
        file_name: body.file_name || 'import.xlsx',
        period_start: dates[0] || null,
        period_end: dates[dates.length - 1] || null,
        imported_by: userId || null,
        created_at: nowIso(),
        lines,
        lineCount: lines.length,
        _schema: 'v2',
        _remodeledAt: new Date(),
    });
    await recalculateBankStatementBalances(db, apartmentId);
    return { importId, count: lines.length };
}

async function matchBankLine(db, apartmentId, userId, body) {
    await updateLine(db, apartmentId, body.line_id, {
        match_status: 'MATCHED',
        transaction_id: body.transaction_id,
        matched_at: nowIso(),
        matched_by: userId || null,
    });
    await db.collection('ledger_entries').updateOne(
        { _id: String(body.transaction_id) },
        { $addToSet: { bankLineRefs: { importId: null, lineId: body.line_id } } },
    );
    return { ok: true };
}

async function unmatchBankLine(db, apartmentId, body) {
    const hit = await findLine(db, apartmentId, body.line_id);
    const txnId = hit?.line?.transaction_id;
    await updateLine(db, apartmentId, body.line_id, {
        match_status: 'UNMATCHED', transaction_id: null, matched_at: null, matched_by: null,
    });
    if (txnId) {
        await db.collection('ledger_entries').updateOne(
            { _id: String(txnId) },
            { $pull: { bankLineRefs: { lineId: body.line_id } } },
        );
    }
    return { ok: true };
}

async function unmatchBankLines(db, apartmentId, body) {
    const ids = body.line_ids || [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await unmatchBankLine(db, apartmentId, { line_id: id });
    }
    return { ok: true, updated: ids.length };
}

async function ignoreBankLine(db, apartmentId, body) {
    await updateLine(db, apartmentId, body.line_id, {
        match_status: 'IGNORED', transaction_id: null, matched_at: null, matched_by: null,
    });
    return { ok: true };
}

async function updateBankStatementLine(db, apartmentId, body) {
    const allowed = ['line_date', 'description', 'debit', 'credit', 'balance'];
    const patch = {};
    for (const k of allowed) {
        if (body.patch && Object.prototype.hasOwnProperty.call(body.patch, k)) patch[k] = body.patch[k];
    }
    await updateLine(db, apartmentId, body.line_id, patch);
    if (patch.line_date != null || patch.debit != null || patch.credit != null) {
        await recalculateBankStatementBalances(db, apartmentId);
    }
    return { ok: true };
}

async function deleteBankStatementLines(db, apartmentId, body) {
    const ids = new Set((body.line_ids || []).map(String));
    const imports = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    let deleted = 0;
    for (const imp of imports) {
        const before = imp.lines?.length || 0;
        const lines = (imp.lines || []).filter((l) => !ids.has(String(l.id || l._id)));
        deleted += before - lines.length;
        if (lines.length !== before) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('bank_imports').updateOne(
                { _id: imp._id },
                { $set: { lines, lineCount: lines.length } },
            );
        }
    }
    await recalculateBankStatementBalances(db, apartmentId);
    return { ok: true, deleted };
}

async function clearBankStatementData(db, apartmentId) {
    await db.collection('bank_imports').deleteMany(apt(apartmentId));
    return { ok: true };
}

async function reorderBankStatementLines(db, apartmentId, body) {
    const updates = body.updates || [];
    const map = new Map(updates.map((u) => [String(u.id), u]));
    const imports = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    for (const imp of imports) {
        let changed = false;
        const lines = (imp.lines || []).map((l) => {
            const u = map.get(String(l.id || l._id));
            if (!u) return l;
            changed = true;
            return {
                ...l,
                line_order: u.line_order ?? l.line_order,
                order_source: u.order_source || l.order_source,
            };
        });
        if (changed) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('bank_imports').updateOne({ _id: imp._id }, { $set: { lines } });
        }
    }
    if (body.recalculate_balances) {
        await recalculateBankStatementBalances(db, apartmentId);
        const dates = (body.updates || []).map((u) => u.line_date || u.date).filter(Boolean);
        const fromDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
        await markLedgerBalanceDirty(db, apartmentId, fromDate);
        await recalculateLedgerBalances(db, apartmentId, {});
    }
    return { ok: true };
}

async function createTxnFromBankLine(db, apartmentId, userId, body) {
    const hit = await findLine(db, apartmentId, body.line_id);
    if (!hit) throw Object.assign(new Error('Bank line not found.'), { status: 404 });
    const line = hit.line;
    const credit = parseFloat(line.credit) || 0;
    const debit = parseFloat(line.debit) || 0;
    const isIncome = credit > 0;
    const amount = isIncome ? credit : debit;
    const res = await saveTransaction(db, apartmentId, {
        transaction: {
            type: isIncome ? 'IN' : 'OUT',
            wallet: 'BANK',
            date: line.line_date,
            amount,
            description: line.description,
            cat: body.cat || (isIncome ? 'Other Income' : 'Other'),
            sub_category: body.sub_category || null,
            vendor_name: body.vendor_name || null,
            exclude_from_reports: body.exclude_from_reports === true,
        },
    });
    await matchBankLine(db, apartmentId, userId, {
        line_id: body.line_id,
        transaction_id: res.transaction.id,
    });
    return { ok: true, txnId: res.transaction.id, ledgerBalance: res.ledgerBalance || null };
}

async function createTxnsFromBankLines(db, apartmentId, userId, body) {
    const rows = body.rows || [];
    const results = [];
    let posted = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const hit = await findLine(db, apartmentId, row.line_id);
            if (!hit || hit.line.match_status !== 'UNMATCHED') {
                failed += 1;
                results.push({ line_id: row.line_id, ok: false, error: 'not unmatched' });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const r = await createTxnFromBankLine(db, apartmentId, userId, row);
            posted += 1;
            results.push({ line_id: row.line_id, ok: true, txnId: r.txnId });
        } catch (err) {
            failed += 1;
            results.push({ line_id: row.line_id, ok: false, error: err.message });
        }
    }
    return { ok: true, posted, failed, results };
}

async function createLedgerFromBankLineAuto(db, apartmentId, userId, body) {
    const hit = await findLine(db, apartmentId, body.line_id);
    if (!hit) throw Object.assign(new Error('Bank line not found.'), { status: 404 });
    const line = hit.line;
    const credit = parseFloat(line.credit) || 0;
    const debit = parseFloat(line.debit) || 0;
    const isIncome = credit > 0;
    const amount = isIncome ? credit : debit;
    let cat = isIncome ? 'Other Income' : 'Other';
    const desc = `${line.description || ''} ${body.nobroker_row?.description || ''}`.toLowerCase();
    if (isIncome && /nobroker|maintenance|maint/.test(desc)) cat = 'Maintenance Collection';
    const res = await saveTransaction(db, apartmentId, {
        transaction: {
            type: isIncome ? 'IN' : 'OUT',
            wallet: 'BANK',
            date: line.line_date,
            amount,
            description: line.description,
            cat,
            bank_reference: body.nobroker_row?.reference || null,
        },
    });
    await matchBankLine(db, apartmentId, userId, {
        line_id: body.line_id,
        transaction_id: res.transaction.id,
    });
    return { ok: true, txnId: res.transaction.id, ledgerBalance: res.ledgerBalance || null };
}

async function saveBankClassificationRule(db, apartmentId, body) {
    const cfg = await ensureConfig(db, apartmentId);
    const list = [...(cfg.classificationRules || [])];
    const id = body.id || uid();
    const rule = {
        id,
        apartment_id: apartmentId,
        description_match: body.description_match || '',
        category: body.category || null,
        line_type: body.line_type || null,
        sub_category: body.sub_category || null,
        vendor_name: body.vendor_name || null,
        priority: body.priority ?? 0,
        enabled: body.enabled !== false,
        exclude_from_reports: body.exclude_from_reports === true,
        created_at: nowIso(),
    };
    const idx = list.findIndex((r) => String(r.id) === String(id));
    if (idx >= 0) list[idx] = { ...list[idx], ...rule };
    else list.push(rule);
    await saveConfig(db, apartmentId, { classificationRules: list });
    return { ok: true, rule };
}

async function deleteBankClassificationRule(db, apartmentId, body) {
    const id = body.id || body.rule_id;
    const cfg = await ensureConfig(db, apartmentId);
    const list = (cfg.classificationRules || []).filter((r) => String(r.id) !== String(id));
    await saveConfig(db, apartmentId, { classificationRules: list });
    return { ok: true };
}

async function listBankClassificationRules(db, apartmentId) {
    const cfg = await ensureConfig(db, apartmentId);
    const rules = [...(cfg.classificationRules || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return { rules };
}

async function previewBankClassificationRules(db, apartmentId) {
    const { rules } = await listBankClassificationRules(db, apartmentId);
    const enabled = rules.filter((r) => r.enabled !== false);
    const imports = await db.collection('bank_imports').find(apt(apartmentId)).toArray();
    const matches = [];
    let examined = 0;
    let noRule = 0;
    for (const imp of imports) {
        for (const line of imp.lines || []) {
            if (line.match_status !== 'UNMATCHED') continue;
            examined += 1;
            const desc = String(line.description || '').toLowerCase();
            const rule = enabled.find((r) => desc.includes(String(r.description_match || '').toLowerCase()));
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
                exclude_from_reports: rule.exclude_from_reports,
            });
        }
    }
    return {
        matches,
        ruleCount: enabled.length,
        examined,
        noRule,
        sampleLineDescription: null,
        sampleRuleMatch: null,
    };
}

async function bulkUpdateTransactions(db, apartmentId, body) {
    const updates = body.updates || [];
    const allowed = ['cat', 'sub_category', 'description', 'exclude_from_reports', 'vendor_name', 'excluded_from_ledger',
        'amount', 'type', 'wallet', 'date'];
    let updated = 0;
    let dirtyFrom = null;
    for (const u of updates) {
        const patch = {};
        for (const k of allowed) {
            if (u.fields && Object.prototype.hasOwnProperty.call(u.fields, k)) patch[k] = u.fields[k];
            else if (Object.prototype.hasOwnProperty.call(u, k) && k !== 'id') patch[k] = u[k];
        }
        if (!u.id || !Object.keys(patch).length) continue;
        const existing = await db.collection('ledger_entries').findOne({ _id: String(u.id), ...apt(apartmentId) });
        // eslint-disable-next-line no-await-in-loop
        const res = await db.collection('ledger_entries').updateOne(
            { _id: String(u.id), ...apt(apartmentId) },
            { $set: patch },
        );
        updated += res.modifiedCount || 0;
        const balanceTouched = ['amount', 'type', 'wallet', 'date', 'excluded_from_ledger']
            .some((k) => Object.prototype.hasOwnProperty.call(patch, k));
        if (balanceTouched) {
            dirtyFrom = minDay(dirtyFrom, minDay(existing?.date, patch.date || existing?.date));
        }
    }
    let ledgerBalance = null;
    if (dirtyFrom || updated) {
        // Only mark dirty when a balance-affecting field was touched
        const anyBalance = updates.some((u) => {
            const fields = u.fields || u;
            return ['amount', 'type', 'wallet', 'date', 'excluded_from_ledger']
                .some((k) => Object.prototype.hasOwnProperty.call(fields, k));
        });
        if (anyBalance) {
            ledgerBalance = await markLedgerBalanceDirty(db, apartmentId, dirtyFrom);
        }
    }
    return { ok: true, updated, ledgerBalance };
}

async function setLedgerExclusion(db, apartmentId, body) {
    const excluded = body.excluded_from_ledger !== false;
    const existing = await db.collection('ledger_entries').findOne({
        _id: String(body.transaction_id), ...apt(apartmentId),
    });
    await db.collection('ledger_entries').updateOne(
        { _id: String(body.transaction_id), ...apt(apartmentId) },
        { $set: { excluded_from_ledger: excluded } },
    );
    let ledgerBalance = null;
    if (existing && isBankTxn(existing)) {
        ledgerBalance = await markLedgerBalanceDirty(db, apartmentId, existing.date);
    }
    return { ok: true, excluded, ledgerBalance };
}

async function returnLedgerTxnToStatement(db, apartmentId, userId, body) {
    const txn = await db.collection('ledger_entries').findOne({
        _id: String(body.transaction_id), ...apt(apartmentId),
    });
    if (!txn) throw Object.assign(new Error('Transaction not found.'), { status: 404 });
    if ((txn.wallet || '').toUpperCase() !== 'BANK') {
        throw Object.assign(new Error('Only bank ledger lines can return to statement.'), { status: 400 });
    }
    const importId = uid();
    const lineId = uid();
    const isIncome = txn.type === 'IN';
    const line = {
        id: lineId,
        line_date: txn.date,
        description: txn.description,
        debit: isIncome ? 0 : txn.amount,
        credit: isIncome ? txn.amount : 0,
        balance: null,
        line_order: 0,
        match_status: 'UNMATCHED',
        transaction_id: null,
    };
    await db.collection('bank_imports').insertOne({
        _id: importId,
        id: importId,
        apartment_id: apartmentId,
        file_name: 'returned-from-ledger',
        created_at: nowIso(),
        imported_by: userId || null,
        lines: [line],
        lineCount: 1,
        _schema: 'v2',
        _remodeledAt: new Date(),
    });
    await deleteTransaction(db, apartmentId, { transaction_id: txn.id });
    return { ok: true, line_id: lineId, import_id: importId };
}

async function saveExpensePlanItem(db, apartmentId, body) {
    const item = body.item || body;
    const cfg = await ensureConfig(db, apartmentId);
    const list = [...(cfg.expensePlanItems || [])];
    const id = item.id || uid();
    const row = {
        ...item, id, apartment_id: apartmentId, amount: roundMoney(item.amount),
        plan_date: item.plan_date ? String(item.plan_date).slice(0, 10) : null,
    };
    const idx = list.findIndex((x) => String(x.id) === String(id));
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push(row);
    const config = await saveConfig(db, apartmentId, { expensePlanItems: list });
    return { ok: true, item: row, config };
}

async function deleteExpensePlanItem(db, apartmentId, body) {
    const id = body.item_id || body.id;
    const cfg = await ensureConfig(db, apartmentId);
    const list = (cfg.expensePlanItems || []).filter((x) => String(x.id) !== String(id));
    const config = await saveConfig(db, apartmentId, { expensePlanItems: list });
    return { ok: true, id, config };
}

async function saveExpensePlanRecurring(db, apartmentId, body) {
    const item = body.recurring || body.item || body;
    const cfg = await ensureConfig(db, apartmentId);
    const list = [...(cfg.expensePlanRecurring || [])];
    const id = item.id || uid();
    const row = { ...item, id, apartment_id: apartmentId, amount: roundMoney(item.amount) };
    const idx = list.findIndex((x) => String(x.id) === String(id));
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push(row);
    const config = await saveConfig(db, apartmentId, { expensePlanRecurring: list });
    return { recurring: row, config };
}

async function deleteExpensePlanRecurring(db, apartmentId, body) {
    const id = body.recurring_id || body.id;
    const cfg = await ensureConfig(db, apartmentId);
    const list = (cfg.expensePlanRecurring || []).filter((x) => String(x.id) !== String(id));
    await saveConfig(db, apartmentId, { expensePlanRecurring: list });
    return { ok: true, id };
}

/** Generic table writes for Finance-New billing / config helpers (explicit mongoWrite client). */
async function tableWrite(db, apartmentId, body) {
    const table = body.table;
    const op = body.op;
    const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : []);
    const filter = body.filter || {};

    if (table === 'expense_vendors' || table === 'expense_sub_categories'
        || table === 'maintenance_charge_heads' || table === 'maintenance_penalty_rules'
        || table === 'bank_classification_rules' || table === 'staff_members') {
        const keyMap = {
            expense_vendors: 'vendors',
            expense_sub_categories: 'subCategories',
            maintenance_charge_heads: 'chargeHeads',
            maintenance_penalty_rules: 'penaltyRules',
            bank_classification_rules: 'classificationRules',
            staff_members: 'staff',
        };
        const field = keyMap[table];
        const cfg = await ensureConfig(db, apartmentId);
        let list = [...(cfg[field] || [])];
        if (op === 'upsert' || op === 'insert') {
            for (const row of rows) {
                const id = row.id || uid();
                const next = { ...row, id, apartment_id: apartmentId };
                if (table === 'expense_vendors' && next.name) {
                    next.name = titleCaseVendorName(next.name);
                }
                const idx = list.findIndex((x) => String(x.id) === String(id)
                    || (table === 'expense_vendors' && String(x.name).toLowerCase() === String(next.name || '').toLowerCase())
                    || (table === 'expense_sub_categories'
                        && x.category === row.category && String(x.name).toLowerCase() === String(row.name || '').toLowerCase()));
                if (idx >= 0) list[idx] = { ...list[idx], ...next };
                else list.push(next);
            }
        } else if (op === 'delete') {
            const id = filter.id || rows[0]?.id;
            list = list.filter((x) => String(x.id) !== String(id));
        }
        const config = await saveConfig(db, apartmentId, { [field]: list });
        return { ok: true, data: list, config };
    }

    if (table === 'transactions') {
        if (op === 'insert' || op === 'upsert') {
            const out = [];
            for (const row of rows) {
                // eslint-disable-next-line no-await-in-loop
                const res = await saveTransaction(db, apartmentId, { transaction: row });
                out.push(res.transaction);
            }
            return { ok: true, data: out };
        }
        if (op === 'delete') {
            await deleteTransaction(db, apartmentId, { transaction_id: filter.id });
            return { ok: true };
        }
        if (op === 'update') {
            await db.collection('ledger_entries').updateOne(
                { _id: String(filter.id), ...apt(apartmentId) },
                { $set: body.patch || rows[0] || {} },
            );
            return { ok: true };
        }
    }

    if (table === 'maintenance_invoices') {
        if (op === 'insert' || op === 'upsert') {
            const out = [];
            for (const row of rows) {
                const id = row.id || uid();
                const doc = {
                    ...row,
                    _id: String(id),
                    id,
                    apartment_id: apartmentId,
                    lines: row.lines || [],
                    payments: row.payments || [],
                    _schema: 'v2',
                    _remodeledAt: new Date(),
                };
                // eslint-disable-next-line no-await-in-loop
                await db.collection('dues_invoices').replaceOne({ _id: String(id) }, doc, { upsert: true });
                out.push(stripMongo(doc));
            }
            return { ok: true, data: out };
        }
        if (op === 'update') {
            await db.collection('dues_invoices').updateOne(
                { _id: String(filter.id), ...apt(apartmentId) },
                { $set: { ...(body.patch || rows[0] || {}), _remodeledAt: new Date() } },
            );
            return { ok: true };
        }
        if (op === 'delete') {
            await db.collection('dues_invoices').deleteOne({ _id: String(filter.id), ...apt(apartmentId) });
            return { ok: true };
        }
    }

    if (table === 'maintenance_invoice_lines') {
        // Embed into parent invoice
        for (const row of rows) {
            const invoiceId = row.invoice_id || filter.invoice_id;
            if (!invoiceId) continue;
            const line = { ...row, id: row.id || uid() };
            if (op === 'insert' || op === 'upsert') {
                // eslint-disable-next-line no-await-in-loop
                await db.collection('dues_invoices').updateOne(
                    { _id: String(invoiceId) },
                    { $pull: { lines: { id: line.id } } },
                );
                // eslint-disable-next-line no-await-in-loop
                await db.collection('dues_invoices').updateOne(
                    { _id: String(invoiceId) },
                    { $push: { lines: line } },
                );
            }
        }
        if (op === 'insert' && Array.isArray(rows) && rows.length > 1) {
            // bulk insert already handled in loop
        }
        return { ok: true, data: rows };
    }

    if (table === 'maintenance_payment_allocations') {
        for (const row of rows) {
            const payment = {
                id: row.id || uid(),
                transaction_id: row.transaction_id,
                amount: roundMoney(row.amount),
                created_at: row.created_at || nowIso(),
            };
            // eslint-disable-next-line no-await-in-loop
            await db.collection('dues_invoices').updateOne(
                { _id: String(row.invoice_id) },
                { $push: { payments: payment } },
            );
            if (row.transaction_id) {
                // eslint-disable-next-line no-await-in-loop
                await db.collection('ledger_entries').updateOne(
                    { _id: String(row.transaction_id) },
                    {
                        $addToSet: {
                            maintenancePayments: {
                                allocationId: payment.id,
                                invoiceId: row.invoice_id,
                                amount: payment.amount,
                            },
                        },
                    },
                );
            }
        }
        return { ok: true, data: rows };
    }

    if (table === 'maintenance_billing_groups') {
        if (op === 'upsert' || op === 'insert') {
            const out = [];
            for (const row of rows) {
                const id = row.id || uid();
                const doc = {
                    ...row, _id: String(id), id, apartment_id: apartmentId, unitIds: row.unitIds || [],
                    _schema: 'v2', _remodeledAt: new Date(),
                };
                // eslint-disable-next-line no-await-in-loop
                await db.collection('billing_groups').replaceOne({ _id: String(id) }, doc, { upsert: true });
                out.push(stripMongo(doc));
            }
            return { ok: true, data: out };
        }
        if (op === 'delete') {
            await db.collection('billing_groups').deleteOne({ _id: String(filter.id) });
            return { ok: true };
        }
    }

    if (table === 'maintenance_billing_group_units') {
        for (const row of rows) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('billing_groups').updateOne(
                { _id: String(row.group_id) },
                { $addToSet: { unitIds: row.unit_id } },
            );
        }
        if (op === 'delete' && filter.group_id) {
            await db.collection('billing_groups').updateOne(
                { _id: String(filter.group_id) },
                { $set: { unitIds: [] } },
            );
        }
        return { ok: true };
    }

    if (table === 'maintenance_billing_batches') {
        if (op === 'insert' || op === 'upsert') {
            const out = [];
            for (const row of rows) {
                const id = row.id || uid();
                const doc = {
                    ...row, _id: String(id), id, apartment_id: apartmentId, skips: row.skips || [],
                    _schema: 'v2', _remodeledAt: new Date(),
                };
                // eslint-disable-next-line no-await-in-loop
                await db.collection('billing_batches').replaceOne({ _id: String(id) }, doc, { upsert: true });
                out.push(stripMongo(doc));
            }
            return { ok: true, data: out };
        }
        if (op === 'update') {
            await db.collection('billing_batches').updateOne(
                { _id: String(filter.id) },
                { $set: body.patch || rows[0] || {} },
            );
            return { ok: true };
        }
    }

    if (table === 'maintenance_billing_batch_skips') {
        for (const row of rows) {
            // eslint-disable-next-line no-await-in-loop
            await db.collection('billing_batches').updateOne(
                { _id: String(row.batch_id) },
                { $push: { skips: { ...row, id: row.id || uid() } } },
            );
        }
        return { ok: true };
    }

    if (table === 'maintenance_reminder_log') {
        const out = [];
        for (const row of rows) {
            const id = row.id || uid();
            const doc = {
                ...row, _id: String(id), id, apartment_id: apartmentId, created_at: row.created_at || nowIso(),
                _schema: 'v2',
            };
            // eslint-disable-next-line no-await-in-loop
            await db.collection('maintenance_reminders').insertOne(doc);
            out.push(stripMongo(doc));
        }
        return { ok: true, data: out };
    }

    if (table === 'nobroker_invoices_raised') {
        if (op === 'insert' || op === 'upsert') {
            const out = [];
            for (const row of rows) {
                const id = row.id || uid();
                const doc = { ...row, _id: String(id), id, apartment_id: apartmentId, _schema: 'v2' };
                // eslint-disable-next-line no-await-in-loop
                await db.collection('nobroker_invoices').replaceOne({ _id: String(id) }, doc, { upsert: true });
                out.push(stripMongo(doc));
            }
            return { ok: true, data: out };
        }
        if (op === 'delete') {
            const q = { ...apt(apartmentId) };
            if (filter.id) q._id = String(filter.id);
            if (filter.billing_month) q.billing_month = filter.billing_month;
            await db.collection('nobroker_invoices').deleteMany(q);
            return { ok: true };
        }
    }

    if (table === 'payment_intents') {
        if (op === 'insert') {
            const out = [];
            for (const row of rows) {
                const id = row.id || uid();
                const doc = { ...row, _id: String(id), id, apartment_id: apartmentId };
                // eslint-disable-next-line no-await-in-loop
                await db.collection('payment_intents').insertOne(doc);
                out.push(doc);
            }
            return { ok: true, data: out };
        }
        if (op === 'update') {
            await db.collection('payment_intents').updateOne(
                { _id: String(filter.id) },
                { $set: body.patch || rows[0] || {} },
            );
            return { ok: true };
        }
    }

    throw Object.assign(new Error(`tableWrite unsupported: ${table}/${op}`), { status: 400 });
}

export const BILLS_ACTIONS = new Set([
    'saveFinanceDocument', 'importFinanceDocuments', 'listFinanceDocuments', 'financeDocumentsAggregates',
]);
export const DELETE_ACTIONS = new Set([
    'deleteTransaction', 'deleteTransactions', 'deleteFinanceDocument',
    'deleteExpensePlanItem', 'deleteExpensePlanRecurring',
]);
export const VIEW_ACTIONS = new Set([
    'listFinanceDocuments', 'financeDocumentsAggregates', 'listBankClassificationRules',
]);

export async function authorizeFinanceMongoMutation(req, action, apartment_id) {
    let auth;
    if (DELETE_ACTIONS.has(action)) {
        auth = await requireApartmentCrud(req, apartment_id, 'accounts', 'delete', 'accounts.edit');
    } else if (BILLS_ACTIONS.has(action)) {
        auth = await requireAnyApartmentPermission(req, apartment_id, BILLS_WRITE);
    } else if (VIEW_ACTIONS.has(action)) {
        auth = await requireAnyApartmentPermission(req, apartment_id, VIEW_PERMS);
    } else {
        auth = await requireApartmentPermission(req, apartment_id, 'accounts.edit');
    }
    return auth;
}

export async function runFinanceMongoMutation(action, { db, apartmentId, user, body }) {
    switch (action) {
        case 'saveTransaction':
        case 'saveLedgerEntry':
            return saveTransaction(db, apartmentId, body);
        case 'deleteTransaction':
        case 'deleteLedgerEntry':
            return deleteTransaction(db, apartmentId, body);
        case 'deleteTransactions':
            return deleteTransactions(db, apartmentId, body);
        case 'saveFinanceDocument':
        case 'saveVoucher':
            return saveFinanceDocument(db, apartmentId, user?.id, body);
        case 'deleteFinanceDocument':
        case 'deleteVoucher':
            return deleteFinanceDocument(db, apartmentId, body);
        case 'importFinanceDocuments':
            return importFinanceDocuments(db, apartmentId, user?.id, body);
        case 'linkFinanceDocuments':
            return linkFinanceDocuments(db, apartmentId, body);
        case 'unlinkFinanceDocuments':
            return unlinkFinanceDocuments(db, apartmentId, body);
        case 'syncFinanceDocumentCategories':
            return syncFinanceDocumentCategories(db, apartmentId, body);
        case 'setCashFloatFlag':
            return setCashFloatFlag(db, apartmentId, body);
        case 'saveCashFloatOpening':
            return saveCashFloatOpening(db, apartmentId, body);
        case 'saveBankOpeningBalance':
            return saveBankOpeningBalance(db, apartmentId, body);
        case 'importBankStatement':
            return importBankStatement(db, apartmentId, user?.id, body);
        case 'matchBankLine':
            return matchBankLine(db, apartmentId, user?.id, body);
        case 'unmatchBankLine':
            return unmatchBankLine(db, apartmentId, body);
        case 'unmatchBankLines':
            return unmatchBankLines(db, apartmentId, body);
        case 'ignoreBankLine':
            return ignoreBankLine(db, apartmentId, body);
        case 'updateBankStatementLine':
            return updateBankStatementLine(db, apartmentId, body);
        case 'deleteBankStatementLines':
            return deleteBankStatementLines(db, apartmentId, body);
        case 'clearBankStatementData':
            return clearBankStatementData(db, apartmentId);
        case 'reorderBankStatementLines':
            return reorderBankStatementLines(db, apartmentId, body);
        case 'recalculateBankStatementBalances':
            return recalculateBankStatementBalances(db, apartmentId);
        case 'recalculateLedgerBalances':
            return recalculateLedgerBalances(db, apartmentId, body);
        case 'createTxnFromBankLine':
            return createTxnFromBankLine(db, apartmentId, user?.id, body);
        case 'createTxnsFromBankLines':
            return createTxnsFromBankLines(db, apartmentId, user?.id, body);
        case 'createLedgerFromBankLineAuto':
            return createLedgerFromBankLineAuto(db, apartmentId, user?.id, body);
        case 'saveBankClassificationRule':
            return saveBankClassificationRule(db, apartmentId, body);
        case 'deleteBankClassificationRule':
            return deleteBankClassificationRule(db, apartmentId, body);
        case 'listBankClassificationRules':
            return listBankClassificationRules(db, apartmentId);
        case 'previewBankClassificationRules':
            return previewBankClassificationRules(db, apartmentId);
        case 'bulkUpdateTransactions':
            return bulkUpdateTransactions(db, apartmentId, body);
        case 'setLedgerExclusion':
            return setLedgerExclusion(db, apartmentId, body);
        case 'returnLedgerTxnToStatement':
            return returnLedgerTxnToStatement(db, apartmentId, user?.id, body);
        case 'saveExpensePlanItem':
            return saveExpensePlanItem(db, apartmentId, body);
        case 'deleteExpensePlanItem':
            return deleteExpensePlanItem(db, apartmentId, body);
        case 'saveExpensePlanRecurring':
            return saveExpensePlanRecurring(db, apartmentId, body);
        case 'deleteExpensePlanRecurring':
            return deleteExpensePlanRecurring(db, apartmentId, body);
        case 'patchFinanceConfig':
            return { ok: true, config: await saveConfig(db, apartmentId, body.patch || {}) };
        case 'tableWrite':
            return tableWrite(db, apartmentId, body);
        default:
            throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const started = Date.now();
    let apartmentId = null;
    let userId = null;
    let action = null;
    try {
        const body = await readJsonBody(req);
        action = body.action;
        const auth = await authorizeFinanceMongoMutation(req, action, body.apartment_id);
        apartmentId = auth.apartmentId;
        userId = auth.user?.id || null;
        const db = await getMongoDb();
        const result = await runFinanceMongoMutation(action, {
            db,
            apartmentId,
            user: auth.user,
            body,
        });
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo-mutations',
            op: action,
            collection: body.table || null,
            userId,
            apartmentId,
            ms: Date.now() - started,
        });
        return res.status(200).json(result);
    } catch (err) {
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo-mutations',
            op: action,
            userId,
            apartmentId,
            ms: Date.now() - started,
            error: err.message || 'Finance Mongo mutation failed.',
        });
        return res.status(err.status || 500).json({ error: err.message || 'Finance Mongo mutation failed.' });
    }
}
