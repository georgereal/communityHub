/**
 * Finance-New REST API — Mongo-backed.
 *
 * Examples:
 *   GET    /api/finance/boot?apartment_id=
 *   GET    /api/finance/ledger?apartment_id=
 *   GET    /api/finance/ledger/summary?apartment_id=
 *   POST   /api/finance/ledger
 *   DELETE /api/finance/ledger/:id
 *   GET    /api/finance/vouchers
 *   GET    /api/finance/reports/summary
 *   POST   /api/finance/tables/:table   { op, rows|filter|patch }
 */
import { requireAnyApartmentPermission } from '../serverAuth.js';
import { getQueryParam, readJsonBody } from '../vercelRequest.js';
import { getMongoDb } from '../mongoClient.js';
import { logMongoApi } from '../mongoLog.js';
import {
    authorizeFinanceMongoMutation,
    executeMutation,
    executeRead,
    executeReport,
    VIEW_PERMS,
} from '../financeMongo/index.js';

function pathPartsFromReq(req) {
    if (Array.isArray(req.query?.path)) return req.query.path.map(String);
    if (typeof req.query?.path === 'string' && req.query.path) {
        return req.query.path.split('/').filter(Boolean);
    }
    if (Array.isArray(req.__financePath)) return req.__financePath;
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const idx = u.pathname.indexOf('/api/finance/');
        if (idx >= 0) {
            return u.pathname.slice(idx + '/api/finance/'.length).split('/').filter(Boolean);
        }
    } catch { /* ignore */ }
    return [];
}

function apartmentIdFrom(req, body = {}) {
    return body.apartment_id
        || getQueryParam(req, 'apartment_id')
        || null;
}

async function runRead(req, action, body = {}) {
    const apartment_id = apartmentIdFrom(req, body);
    const auth = await requireAnyApartmentPermission(req, apartment_id, VIEW_PERMS);
    const db = await getMongoDb();
    const result = await executeRead(action, {
        db,
        apartmentId: auth.apartmentId,
        body: { ...body, apartment_id: auth.apartmentId },
    });
    return { auth, result: { ok: true, ...result } };
}

async function runMutation(req, action, body = {}) {
    const apartment_id = apartmentIdFrom(req, body);
    const auth = await authorizeFinanceMongoMutation(req, action, apartment_id);
    const db = await getMongoDb();
    const result = await executeMutation(action, {
        db,
        apartmentId: auth.apartmentId,
        user: auth.user,
        body: { ...body, apartment_id: auth.apartmentId },
    });
    return { auth, result };
}

async function runReport(req, report, body = {}) {
    const apartment_id = apartmentIdFrom(req, body);
    const auth = await requireAnyApartmentPermission(req, apartment_id, VIEW_PERMS);
    const db = await getMongoDb();
    const result = await executeReport(report, {
        db,
        apartmentId: auth.apartmentId,
        body: { ...body, apartment_id: auth.apartmentId },
    });
    return { auth, result: { ok: true, report, ...result } };
}

/**
 * Map method + path segments → { kind, action|report, bodyPatch, collection }
 */
function resolveRoute(method, parts, body, query) {
    const m = method.toUpperCase();
    const [a, b, c] = parts;
    const q = query || {};

    if (!a) {
        return { kind: 'error', status: 404, error: 'Missing resource path under /api/finance/' };
    }

    // GET /boot
    if (a === 'boot' && m === 'GET') return { kind: 'read', action: 'boot', collection: 'finance_config' };

    // /ledger
    if (a === 'ledger') {
        if (m === 'GET' && !b) return { kind: 'read', action: 'loadLedger', collection: 'ledger_entries' };
        if (m === 'GET' && b === 'summary') {
            return { kind: 'read', action: 'ledgerSummary', collection: 'ledger_entries' };
        }
        if (m === 'POST' && !b) return { kind: 'mutation', action: 'saveTransaction', collection: 'ledger_entries' };
        if (m === 'POST' && b === 'recalculate') return { kind: 'mutation', action: 'recalculateLedgerBalances', collection: 'ledger_entries' };
        if (m === 'DELETE' && b && !c) {
            return {
                kind: 'mutation',
                action: 'deleteTransaction',
                collection: 'ledger_entries',
                bodyPatch: { transaction_id: b },
            };
        }
        if (m === 'POST' && b === 'bulk-delete') return { kind: 'mutation', action: 'deleteTransactions', collection: 'ledger_entries' };
        if (m === 'POST' && b === 'bulk-update') return { kind: 'mutation', action: 'bulkUpdateTransactions', collection: 'ledger_entries' };
        if (m === 'POST' && b && c === 'exclusion') {
            return {
                kind: 'mutation',
                action: 'setLedgerExclusion',
                collection: 'ledger_entries',
                bodyPatch: { transaction_id: b },
            };
        }
        if (m === 'POST' && b && c === 'return-to-statement') {
            return {
                kind: 'mutation',
                action: 'returnLedgerTxnToStatement',
                collection: 'ledger_entries',
                bodyPatch: { transaction_id: b },
            };
        }
    }

    // /vouchers
    if (a === 'vouchers') {
        if (m === 'GET' && b === 'aggregates') return { kind: 'read', action: 'voucherAggregates', collection: 'vouchers' };
        if (m === 'GET' && !b) {
            return {
                kind: 'read',
                action: 'listVouchers',
                collection: 'vouchers',
                bodyPatch: {
                    limit: q.limit,
                    offset: q.offset,
                    kind: q.kind,
                    status: q.status,
                    q: q.q,
                    pay: q.pay,
                },
            };
        }
        if (m === 'POST' && !b) return { kind: 'mutation', action: 'saveFinanceDocument', collection: 'vouchers' };
        if (m === 'DELETE' && b && !c) {
            return {
                kind: 'mutation',
                action: 'deleteFinanceDocument',
                collection: 'vouchers',
                bodyPatch: { document_id: b },
            };
        }
        if (m === 'POST' && b === 'import') return { kind: 'mutation', action: 'importFinanceDocuments', collection: 'vouchers' };
        if (m === 'POST' && b === 'link') return { kind: 'mutation', action: 'linkFinanceDocuments', collection: 'vouchers' };
        if (m === 'POST' && b === 'unlink') return { kind: 'mutation', action: 'unlinkFinanceDocuments', collection: 'vouchers' };
        if (m === 'POST' && b === 'sync-categories') return { kind: 'mutation', action: 'syncFinanceDocumentCategories', collection: 'vouchers' };
    }

    // /cash-float
    if (a === 'cash-float') {
        if (m === 'POST' && b === 'flag') return { kind: 'mutation', action: 'setCashFloatFlag', collection: 'finance_config' };
        if (m === 'POST' && b === 'opening') return { kind: 'mutation', action: 'saveCashFloatOpening', collection: 'finance_config' };
    }

    // /bank
    if (a === 'bank') {
        if (b === 'imports') {
            if (m === 'GET') return { kind: 'read', action: 'loadBankImports', collection: 'bank_imports' };
            if (m === 'POST') return { kind: 'mutation', action: 'importBankStatement', collection: 'bank_imports' };
        }
        if (b === 'opening-balance' && m === 'POST') return { kind: 'mutation', action: 'saveBankOpeningBalance', collection: 'finance_config' };
        if (b === 'data' && m === 'DELETE') return { kind: 'mutation', action: 'clearBankStatementData', collection: 'bank_imports' };
        if (b === 'lines') {
            const lineId = c;
            const lineAction = parts[3];
            if (m === 'POST' && c === 'reorder') return { kind: 'mutation', action: 'reorderBankStatementLines', collection: 'bank_imports' };
            if (m === 'POST' && c === 'recalculate') return { kind: 'mutation', action: 'recalculateBankStatementBalances', collection: 'bank_imports' };
            if (m === 'POST' && c === 'unmatch') return { kind: 'mutation', action: 'unmatchBankLines', collection: 'bank_imports' };
            if (m === 'POST' && c === 'create-txns') return { kind: 'mutation', action: 'createTxnsFromBankLines', collection: 'ledger_entries' };
            if (m === 'DELETE' && !c) return { kind: 'mutation', action: 'deleteBankStatementLines', collection: 'bank_imports' };
            if (lineId && lineAction === 'match' && m === 'POST') {
                return {
                    kind: 'mutation',
                    action: 'matchBankLine',
                    collection: 'bank_imports',
                    bodyPatch: { line_id: lineId },
                };
            }
            if (lineId && lineAction === 'unmatch' && m === 'POST') {
                return {
                    kind: 'mutation',
                    action: 'unmatchBankLine',
                    collection: 'bank_imports',
                    bodyPatch: { line_id: lineId },
                };
            }
            if (lineId && lineAction === 'ignore' && m === 'POST') {
                return {
                    kind: 'mutation',
                    action: 'ignoreBankLine',
                    collection: 'bank_imports',
                    bodyPatch: { line_id: lineId },
                };
            }
            if (lineId && lineAction === 'create-txn' && m === 'POST') {
                return {
                    kind: 'mutation',
                    action: 'createTxnFromBankLine',
                    collection: 'ledger_entries',
                    bodyPatch: { line_id: lineId },
                };
            }
            if (lineId && lineAction === 'auto-ledger' && m === 'POST') {
                return {
                    kind: 'mutation',
                    action: 'createLedgerFromBankLineAuto',
                    collection: 'ledger_entries',
                    bodyPatch: { line_id: lineId },
                };
            }
            if (lineId && !lineAction && m === 'PATCH') {
                return {
                    kind: 'mutation',
                    action: 'updateBankStatementLine',
                    collection: 'bank_imports',
                    bodyPatch: { line_id: lineId },
                };
            }
        }
        if (b === 'rules') {
            if (m === 'GET' && !c) return { kind: 'mutation', action: 'listBankClassificationRules', collection: 'finance_config' };
            if (m === 'POST' && !c) return { kind: 'mutation', action: 'saveBankClassificationRule', collection: 'finance_config' };
            if (m === 'POST' && c === 'preview') return { kind: 'mutation', action: 'previewBankClassificationRules', collection: 'finance_config' };
            if (m === 'DELETE' && c) {
                return {
                    kind: 'mutation',
                    action: 'deleteBankClassificationRule',
                    collection: 'finance_config',
                    bodyPatch: { id: c },
                };
            }
        }
    }

    // /billing /nobroker
    if (a === 'billing' && m === 'GET') return { kind: 'read', action: 'loadBilling', collection: 'dues_invoices' };
    if (a === 'nobroker' && m === 'GET') {
        return {
            kind: 'read',
            action: 'listNobroker',
            collection: 'nobroker_invoices',
            bodyPatch: { limit: q.limit, offset: q.offset, unit_number: q.unit_number },
        };
    }

    // /reports/:name
    if (a === 'reports' && b && m === 'GET') {
        return {
            kind: 'report',
            report: b,
            collection: 'reports',
            bodyPatch: {
                type: q.type,
                months: q.months,
                monthCount: q.monthCount || q.months,
                sheetOnly: q.sheetOnly,
                cashExpenseReporting: q.cashExpenseReporting,
                pivotDimension: q.pivotDimension,
            },
        };
    }

    // /expense-plan
    if (a === 'expense-plan') {
        if (b === 'items' && m === 'POST' && !c) return { kind: 'mutation', action: 'saveExpensePlanItem', collection: 'finance_config' };
        if (b === 'items' && m === 'DELETE' && c) {
            return {
                kind: 'mutation',
                action: 'deleteExpensePlanItem',
                collection: 'finance_config',
                bodyPatch: { id: c },
            };
        }
        if (b === 'recurring' && m === 'POST' && !c) return { kind: 'mutation', action: 'saveExpensePlanRecurring', collection: 'finance_config' };
        if (b === 'recurring' && m === 'DELETE' && c) {
            return {
                kind: 'mutation',
                action: 'deleteExpensePlanRecurring',
                collection: 'finance_config',
                bodyPatch: { id: c },
            };
        }
    }

    // /config
    if (a === 'config' && m === 'PATCH') return { kind: 'mutation', action: 'patchFinanceConfig', collection: 'finance_config' };

    // /tables/:table
    if (a === 'tables' && b) {
        const table = b;
        const op = m === 'POST' ? (body.op || 'insert')
            : m === 'PUT' ? 'upsert'
                : m === 'PATCH' ? 'update'
                    : m === 'DELETE' ? 'delete'
                        : null;
        if (!op) return { kind: 'error', status: 405, error: `Method ${m} not allowed for /tables/:table` };
        return {
            kind: 'mutation',
            action: 'tableWrite',
            collection: table,
            bodyPatch: { table, op },
        };
    }

    return {
        kind: 'error',
        status: 404,
        error: `No route for ${m} /api/finance/${parts.join('/')}`,
    };
}

export default async function handler(req, res) {
    const started = Date.now();
    const method = req.method || 'GET';
    const parts = pathPartsFromReq(req);
    const path = `/api/finance/${parts.join('/')}`;
    let apartmentId = null;
    let userId = null;
    let op = null;
    let collection = null;

    try {
        const body = ['GET', 'HEAD'].includes(method.toUpperCase())
            ? {}
            : await readJsonBody(req);
        const query = {
            limit: getQueryParam(req, 'limit'),
            offset: getQueryParam(req, 'offset'),
            kind: getQueryParam(req, 'kind'),
            status: getQueryParam(req, 'status'),
            q: getQueryParam(req, 'q'),
            pay: getQueryParam(req, 'pay'),
            type: getQueryParam(req, 'type'),
            months: getQueryParam(req, 'months'),
            monthCount: getQueryParam(req, 'monthCount'),
            sheetOnly: getQueryParam(req, 'sheetOnly'),
            cashExpenseReporting: getQueryParam(req, 'cashExpenseReporting'),
            pivotDimension: getQueryParam(req, 'pivotDimension'),
        };

        const route = resolveRoute(method, parts, body, query);
        if (route.kind === 'error') {
            logMongoApi({
                method, path, op: null, userId, apartmentId,
                ms: Date.now() - started, error: route.error,
            });
            return res.status(route.status || 404).json({ error: route.error });
        }

        op = route.action || route.report || null;
        collection = route.collection || null;
        const mergedBody = {
            ...body,
            ...(route.bodyPatch || {}),
        };

        let out;
        if (route.kind === 'read') {
            out = await runRead(req, route.action, mergedBody);
        } else if (route.kind === 'report') {
            out = await runReport(req, route.report, mergedBody);
        } else {
            out = await runMutation(req, route.action, mergedBody);
        }

        apartmentId = out.auth?.apartmentId || null;
        userId = out.auth?.user?.id || null;

        logMongoApi({
            method,
            path,
            op,
            collection,
            userId,
            apartmentId,
            ms: Date.now() - started,
        });
        return res.status(200).json(out.result);
    } catch (err) {
        logMongoApi({
            method,
            path,
            op,
            collection,
            userId,
            apartmentId,
            ms: Date.now() - started,
            error: err.message || 'Finance-New request failed.',
        });
        return res.status(err.status || 500).json({ error: err.message || 'Finance-New request failed.' });
    }
}
