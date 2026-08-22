import { bankLineFingerprint } from './bankStatementLineUtils.js';

export const IMPORT_LINE_STATUS = {
    IMPORTED: 'imported',
    SKIPPED_EXISTING: 'skipped_existing',
    SKIPPED_BATCH: 'skipped_batch',
    READY: 'ready',
};

export const IMPORT_LINE_STATUS_LABEL = {
    [IMPORT_LINE_STATUS.IMPORTED]: 'Imported',
    [IMPORT_LINE_STATUS.SKIPPED_EXISTING]: 'Duplicate (existing)',
    [IMPORT_LINE_STATUS.SKIPPED_BATCH]: 'Duplicate (batch)',
    [IMPORT_LINE_STATUS.READY]: 'Ready',
};

function parseMappedLines(job) {
    let mappedLines = job?.mapped_lines;
    if (typeof mappedLines === 'string') {
        try {
            mappedLines = JSON.parse(mappedLines);
        } catch {
            mappedLines = [];
        }
    }
    return Array.isArray(mappedLines) ? mappedLines : [];
}

function passbookJobFileLabel(job) {
    const names = Array.isArray(job?.file_names) && job.file_names.length
        ? job.file_names.join(', ')
        : 'passbook';
    const exec = job?.execution_id ? ` · ${job.execution_id}` : '';
    return `evolyx-passbook:${names}${exec}`;
}

function relatedImportIds(job, bankImports = []) {
    const fileLabel = passbookJobFileLabel(job);
    const ids = new Set(
        (bankImports || [])
            .filter((imp) => imp.file_name === fileLabel)
            .map((imp) => imp.id),
    );
    if (job?.imported_statement_import_id) ids.add(job.imported_statement_import_id);
    return ids;
}

/** Classify mapped OCR rows vs bank reconciliation (same dedupe rules as import). */
export function analyzePassbookJobLines(job, bankLines = [], bankImports = []) {
    const mappedLines = parseMappedLines(job);
    const scanImportIds = relatedImportIds(job, bankImports);

    const importedFromThisScan = new Set(
        (bankLines || [])
            .filter((line) => scanImportIds.has(line.import_id))
            .map(bankLineFingerprint),
    );

    const existingOther = new Set(
        (bankLines || [])
            .filter((line) => !scanImportIds.has(line.import_id))
            .map(bankLineFingerprint),
    );

    const seenInBatch = new Set();
    const rows = [];

    for (let index = 0; index < mappedLines.length; index += 1) {
        const line = mappedLines[index];
        const fingerprint = bankLineFingerprint(line);
        let status;
        let reason;

        if (seenInBatch.has(fingerprint)) {
            status = IMPORT_LINE_STATUS.SKIPPED_BATCH;
            reason = 'Skipped as duplicate within OCR batch (same date, description, amount, and balance)';
        } else {
            seenInBatch.add(fingerprint);
            if (importedFromThisScan.has(fingerprint)) {
                status = IMPORT_LINE_STATUS.IMPORTED;
                reason = 'Imported into bank reconciliation from this passbook scan';
            } else if (existingOther.has(fingerprint)) {
                status = IMPORT_LINE_STATUS.SKIPPED_EXISTING;
                reason = 'Skipped — matches a row from another import or manual entry';
            } else {
                status = IMPORT_LINE_STATUS.READY;
                reason = 'Ready to import';
            }
        }

        rows.push({ line, index, fingerprint, status, reason });
    }

    return {
        rows,
        summary: {
            mapped: rows.length,
            imported: rows.filter((row) => row.status === IMPORT_LINE_STATUS.IMPORTED).length,
            skippedExisting: rows.filter((row) => row.status === IMPORT_LINE_STATUS.SKIPPED_EXISTING).length,
            skippedBatch: rows.filter((row) => row.status === IMPORT_LINE_STATUS.SKIPPED_BATCH).length,
            ready: rows.filter((row) => row.status === IMPORT_LINE_STATUS.READY).length,
            duplicates: rows.filter((row) =>
                row.status === IMPORT_LINE_STATUS.SKIPPED_EXISTING
                || row.status === IMPORT_LINE_STATUS.SKIPPED_BATCH,
            ).length,
            importCountRecorded: job?.import_count || 0,
        },
    };
}
