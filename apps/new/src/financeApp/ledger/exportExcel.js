/**
 * Lazy Excel download for filtered ledger rows.
 */
export async function downloadLedgerExcel(entries, { query = '', category = '' } = {}) {
    const { default: ExcelJS } = await import('exceljs');
    const { filterLedgerEntries } = await import('./view.js');

    const rows = filterLedgerEntries(
        (entries || []).filter((t) => !t.excluded_from_ledger),
        { query, category },
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ledger');
    ws.columns = [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Type', key: 'type', width: 8 },
        { header: 'Wallet', key: 'wallet', width: 10 },
        { header: 'Category', key: 'cat', width: 22 },
        { header: 'Description', key: 'description', width: 36 },
        { header: 'Amount', key: 'amount', width: 14 },
    ];
    for (const t of rows) {
        const amt = Math.abs(Number(t.amount) || 0);
        ws.addRow({
            date: String(t.date || '').slice(0, 10),
            type: t.type || '',
            wallet: t.wallet || 'CASH',
            cat: t.cat || '',
            description: t.vendor_name || t.description || '',
            amount: t.type === 'IN' ? amt : -amt,
        });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
    return rows.length;
}
