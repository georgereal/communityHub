import React, { useMemo, useState } from 'react';
import {
    Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    IconButton, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
    TextField, Tooltip, Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';
import { canEditSetup, deleteVendor, refreshAdminState, saveVendor, vendors } from '../api.js';

const COLS = [
    { key: 'name', label: 'Vendor', canSort: true, canFilter: true },
    { key: 'phone', label: 'Phone', canSort: true, canFilter: true },
    { key: 'email', label: 'Email', canSort: true, canFilter: true },
    { key: 'use', label: 'Use count', canSort: true, canFilter: false },
];

export default function VendorsPage() {
    const qc = useQueryClient();
    const canEdit = canEditSetup();
    const [error, setError] = useState('');
    const [form, setForm] = useState(null);
    const [filter, setFilter] = useState({ name: '', phone: '', email: '', use: '' });
    const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

    const q = useQuery({
        queryKey: ['admin-vendors'],
        queryFn: async () => { await refreshAdminState(); return vendors(); },
    });
    const list = q.data || [];
    const rows = useMemo(() => sortAndFilterRows(list, {
        filters: filter,
        sort,
        getText: (v, key) => {
            if (key === 'name') return v.name || '';
            if (key === 'phone') return v.contact_phone || '';
            if (key === 'email') return v.contact_email || '';
            if (key === 'use') return String(v.use_count || 0);
            return '';
        },
        getSort: (v, key) => (key === 'use' ? Number(v.use_count) || 0 : (v[key === 'phone' ? 'contact_phone' : key === 'email' ? 'contact_email' : 'name'] || '')),
    }), [list, filter, sort]);

    const cards = [
        { key: 'all', label: 'Vendors', value: list.length, tone: 'default' },
        { key: 'used', label: 'Used on expenses', value: list.filter((v) => (v.use_count || 0) > 0).length, tone: 'owner' },
    ];
    const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-vendors'] });

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Vendors"
                subtitle="Payees used in expense entries. Autocomplete draws from this list."
                actions={(
                    <>
                        <Tooltip title="Refresh"><IconButton size="small" onClick={invalidate}>{q.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}</IconButton></Tooltip>
                        {canEdit ? <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => setForm({ name: '', contact_phone: '', contact_email: '', notes: '' })}>Add</Button> : null}
                    </>
                )}
            />
            <SummaryStrip cards={cards} activeKey="all" />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {q.isLoading ? <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box> : (
                <TableContainer component={Paper}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                {COLS.map((col) => (
                                    <TableCell key={col.key}>
                                        <ExcelColHeader col={col} sort={sort} filterValue={filter[col.key]} onSort={(key) => setSort((p) => ({ key, dir: p.key === key && p.dir === 'asc' ? 'desc' : 'asc' }))} onFilter={(v) => setFilter((f) => ({ ...f, [col.key]: v }))} onClear={() => setFilter((f) => ({ ...f, [col.key]: '' }))} />
                                    </TableCell>
                                ))}
                                <TableCell align="right" />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.length ? rows.map((v) => (
                                <TableRow key={v.id} hover>
                                    <TableCell><Typography fontWeight={600}>{v.name}</Typography></TableCell>
                                    <TableCell>{v.contact_phone || '—'}</TableCell>
                                    <TableCell>{v.contact_email || '—'}</TableCell>
                                    <TableCell>{v.use_count || 0}</TableCell>
                                    <TableCell align="right">
                                        {canEdit ? (
                                            <>
                                                <IconButton size="small" onClick={() => setForm({ ...v })}><EditIcon fontSize="small" /></IconButton>
                                                <IconButton size="small" color="error" onClick={async () => {
                                                    if (!window.confirm('Delete this vendor?')) return;
                                                    try { await deleteVendor(v.id); invalidate(); } catch (err) { setError(err.message); }
                                                }}><DeleteIcon fontSize="small" /></IconButton>
                                            </>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                            )) : <TableRow><TableCell colSpan={5}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No vendors yet.</Typography></TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <Dialog open={Boolean(form)} onClose={() => setForm(null)} fullWidth maxWidth="sm">
                <DialogTitle>{form?.id ? 'Edit vendor' : 'Add vendor'}</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'grid', gap: 2, mt: 1 }}>
                        <TextField label="Name" size="small" value={form?.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                        <TextField label="Phone" size="small" value={form?.contact_phone || ''} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
                        <TextField label="Email" size="small" value={form?.contact_email || ''} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
                        <TextField label="Notes" size="small" multiline minRows={2} value={form?.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setForm(null)}>Cancel</Button>
                    <Button variant="contained" onClick={async () => {
                        try { await saveVendor(form); setForm(null); invalidate(); } catch (err) { setError(err.message); }
                    }}>Save</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
