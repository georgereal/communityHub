import React, { useMemo, useState } from 'react';
import {
    Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    IconButton, MenuItem, Paper, Table, TableBody, TableCell, TableContainer, TableHead,
    TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';
import { canEditSetup, deleteSubCategory, defaultExpenseCategory, expenseCategoryOptions, refreshFinanceCategoryCatalog, saveSubCategory, subCategories } from '../api.js';

const COLS = [
    { key: 'category', label: 'Category', canSort: true, canFilter: true },
    { key: 'name', label: 'Sub-category', canSort: true, canFilter: true },
    { key: 'use', label: 'Use count', canSort: true, canFilter: false },
];

export default function CategoriesPage() {
    const qc = useQueryClient();
    const canEdit = canEditSetup();
    const [error, setError] = useState('');
    const [form, setForm] = useState(null);
    const [catFilter, setCatFilter] = useState('');
    const [filter, setFilter] = useState({ category: '', name: '', use: '' });
    const [sort, setSort] = useState({ key: 'category', dir: 'asc' });

    const q = useQuery({
        queryKey: ['admin-subcats'],
        queryFn: async () => { await refreshFinanceCategoryCatalog(); return subCategories(); },
    });
    const catOptions = useMemo(() => {
        const live = expenseCategoryOptions();
        const fromRows = (q.data || []).map((r) => r.category).filter(Boolean);
        return [...new Set([...live, ...fromRows])];
    }, [q.data]);
    const list = (q.data || []).filter((r) => !catFilter || r.category === catFilter);
    const rows = useMemo(() => sortAndFilterRows(list, {
        filters: filter,
        sort,
        getText: (r, key) => (key === 'use' ? String(r.use_count || 0) : (r[key] || '')),
        getSort: (r, key) => (key === 'use' ? Number(r.use_count) || 0 : (r[key] || '')),
    }), [list, filter, sort]);

    const byCat = new Set((q.data || []).map((r) => r.category)).size;
    const cards = [
        { key: 'all', label: 'Sub-categories', value: (q.data || []).length, tone: 'default' },
        { key: 'cats', label: 'Categories in use', value: byCat, tone: 'owner' },
    ];
    const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-subcats'] });

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Sub-categories"
                subtitle="Finer labels grouped under each expense category."
                actions={(
                    <>
                        <TextField select size="small" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} sx={{ minWidth: 160 }} aria-label="Filter category">
                            <MenuItem value="">All categories</MenuItem>
                            {catOptions.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                        </TextField>
                        <Tooltip title="Refresh"><IconButton size="small" onClick={invalidate}>{q.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}</IconButton></Tooltip>
                        {canEdit ? <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => setForm({ category: catOptions[0] || defaultExpenseCategory(), name: '' })}>Add</Button> : null}
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
                            {rows.length ? rows.map((r) => (
                                <TableRow key={r.id} hover>
                                    <TableCell>{r.category}</TableCell>
                                    <TableCell><Typography fontWeight={600}>{r.name}</Typography></TableCell>
                                    <TableCell>{r.use_count || 0}</TableCell>
                                    <TableCell align="right">
                                        {canEdit ? (
                                            <>
                                                <IconButton size="small" onClick={() => setForm({ ...r })}><EditIcon fontSize="small" /></IconButton>
                                                <IconButton size="small" color="error" onClick={async () => {
                                                    if (!window.confirm('Delete this sub-category?')) return;
                                                    try { await deleteSubCategory(r.id); invalidate(); } catch (err) { setError(err.message); }
                                                }}><DeleteIcon fontSize="small" /></IconButton>
                                            </>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                            )) : <TableRow><TableCell colSpan={4}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No sub-categories yet.</Typography></TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <Dialog open={Boolean(form)} onClose={() => setForm(null)} fullWidth maxWidth="sm">
                <DialogTitle>{form?.id ? 'Edit sub-category' : 'Add sub-category'}</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'grid', gap: 2, mt: 1 }}>
                        <TextField select label="Category" size="small" value={form?.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                            {[...new Set([...catOptions, form?.category].filter(Boolean))].map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                        </TextField>
                        <TextField label="Name" size="small" value={form?.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setForm(null)}>Cancel</Button>
                    <Button variant="contained" onClick={async () => {
                        try { await saveSubCategory(form); setForm(null); invalidate(); } catch (err) { setError(err.message); }
                    }}>Save</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
