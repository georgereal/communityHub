import { requireApartmentPermission } from './serverAuth.js';
import { prepareImportedStatementLines, computeRunningBalances } from '../src/bankStatementOrdering.js';
import { inferExpenseCategory, BANK_REJECT_CAT } from '../src/expenseCategories.js';
import { findMatchingRule } from '../src/bankClassificationRules.js';

const RECEIPT_BUCKET = 'transaction-receipts';

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
    for (const [id, computed_balance] of balances) {
        const { error } = await service
            .from('bank_statement_lines')
            .update({ computed_balance })
            .eq('apartment_id', apartmentId)
            .eq('id', id);
        if (error && !/computed_balance/i.test(error.message)) {
            throw Object.assign(new Error(error.message), { status: 500 });
        }
    }
}

async function importBankStatementMutation(service, apartmentId, userId, body) {
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (!rawLines.length) return { importId: null, count: 0 };

    const opening = await getBankOpeningForApartment(service, apartmentId);
    const lines = prepareImportedStatementLines(rawLines, opening);
    const importId = crypto.randomUUID();
    const dates = lines.map((l) => l.line_date).filter(Boolean).sort();
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

    const payload = lines.map((line) => ({
        id: crypto.randomUUID(),
        import_id: importId,
        apartment_id: apartmentId,
        line_date: line.line_date,
        description: line.description || null,
        debit: line.debit || 0,
        credit: line.credit || 0,
        balance: line.balance ?? null,
        line_order: line.line_order ?? 0,
        source_row_index: line.source_row_index ?? null,
        order_source: line.order_source || 'auto',
        match_status: 'UNMATCHED',
    }));
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
    for (const row of updates) {
        if (!row?.id) continue;
        const { error } = await service.from('bank_statement_lines').update({
            line_order: row.line_order ?? 0,
            order_source: 'manual',
        }).eq('apartment_id', apartmentId).eq('id', row.id);
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
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

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const body = req.body || await readJsonBody(req);
        const action = body.action;
        const auth = await requireApartmentPermission(req, body.apartment_id, 'accounts.edit');
        const { apartmentId, service, user } = auth;

        let result;
        switch (action) {
            case 'saveTransaction':
                result = await saveTransactionMutation(service, apartmentId, body);
                break;
            case 'deleteTransaction':
                result = await deleteTransactionMutation(service, apartmentId, body);
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
