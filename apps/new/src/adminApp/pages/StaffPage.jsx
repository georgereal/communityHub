import React, { useMemo, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    FormControlLabel, IconButton, MenuItem, Paper, Switch, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import CapGate from '../../components/CapGate.jsx';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';
import { deleteStaff, refreshAdminState, saveStaff, STAFF_ROLES, staffMembers } from '../api.js';

const COLS = [
    { key: 'name', label: 'Name', canSort: true, canFilter: true },
    { key: 'role', label: 'Role', canSort: true, canFilter: true },
    { key: 'phone', label: 'Phone', canSort: true, canFilter: true },
    { key: 'email', label: 'Email', canSort: true, canFilter: true },
    { key: 'status', label: 'Status', canSort: true, canFilter: true },
];

export default function StaffPage() {
    const qc = useQueryClient();
    const [error, setError] = useState('');
    const [form, setForm] = useState(null);
    const [statusFilter, setStatusFilter] = useState('all');
    const [filter, setFilter] = useState({ name: '', role: '', phone: '', email: '', status: '' });
    const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

    const q = useQuery({
        queryKey: ['admin-staff'],
        queryFn: async () => { await refreshAdminState(); return staffMembers(); },
    });
    const list = q.data || [];
    const scoped = list.filter((s) => {
        if (statusFilter === 'active') return s.active !== false;
        if (statusFilter === 'inactive') return s.active === false;
        return true;
    });
    const rows = useMemo(() => sortAndFilterRows(scoped, {
        filters: filter,
        sort,
        getText: (s, key) => {
            if (key === 'name') return s.full_name || '';
            if (key === 'role') return s.role_title || '';
            if (key === 'status') return s.active !== false ? 'Active' : 'Inactive';
            return s[key] || '';
        },
    }), [scoped, filter, sort]);

    const activeCount = list.filter((s) => s.active !== false).length;
    const cards = [
        { key: 'all', label: 'Staff', value: list.length, tone: 'default' },
        { key: 'active', label: 'Active', value: activeCount, tone: 'owner' },
        { key: 'inactive', label: 'Inactive', value: list.length - activeCount, tone: 'warn' },
    ];
    const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-staff'] });

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Staff directory"
                subtitle="Guards, housekeeping, managers, and other on-site staff (not login accounts)."
                actions={(
                    <>
                        <Tooltip title="Refresh"><IconButton size="small" onClick={invalidate}>{q.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}</IconButton></Tooltip>
                        <CapGate cap="admin.staff.edit">
                            <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => setForm({ full_name: '', role_title: STAFF_ROLES[0], phone: '', email: '', notes: '', active: true })}>Add</Button>
                        </CapGate>
                    </>
                )}
            />
            <SummaryStrip cards={cards} activeKey={statusFilter} onSelect={(k) => setStatusFilter(k || 'all')} />
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
                            {rows.length ? rows.map((s) => (
                                <TableRow key={s.id} hover sx={{ opacity: s.active === false ? 0.65 : 1 }}>
                                    <TableCell><Typography fontWeight={600}>{s.full_name}</Typography></TableCell>
                                    <TableCell>{s.role_title}</TableCell>
                                    <TableCell>{s.phone || '—'}</TableCell>
                                    <TableCell>{s.email || '—'}</TableCell>
                                    <TableCell><Chip size="small" label={s.active !== false ? 'Active' : 'Inactive'} color={s.active !== false ? 'success' : 'default'} /></TableCell>
                                    <TableCell align="right">
                                        <CapGate cap="admin.staff.edit">
                                            <IconButton size="small" onClick={() => setForm({ ...s, active: s.active !== false })}><EditIcon fontSize="small" /></IconButton>
                                        </CapGate>
                                        <CapGate cap="admin.staff.edit">
                                            <IconButton size="small" color="error" onClick={async () => {
                                                if (!window.confirm('Delete this staff record?')) return;
                                                try { await deleteStaff(s.id); invalidate(); } catch (err) { setError(err.message); }
                                            }}><DeleteIcon fontSize="small" /></IconButton>
                                        </CapGate>
                                    </TableCell>
                                </TableRow>
                            )) : <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No staff records yet.</Typography></TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <Dialog open={Boolean(form)} onClose={() => setForm(null)} fullWidth maxWidth="sm">
                <DialogTitle>{form?.id ? 'Edit staff' : 'Add staff'}</DialogTitle>
                <DialogContent>
                    <CapGate cap="admin.staff.edit" mode="disable">
                        <Box sx={{ display: 'grid', gap: 2, mt: 1 }}>
                            <TextField label="Name" size="small" value={form?.full_name || ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
                            <TextField select label="Role" size="small" value={form?.role_title || STAFF_ROLES[0]} onChange={(e) => setForm({ ...form, role_title: e.target.value })}>
                                {STAFF_ROLES.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                            </TextField>
                            <TextField label="Phone" size="small" value={form?.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                            <TextField label="Email" size="small" value={form?.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                            <TextField label="Notes" size="small" multiline minRows={2} value={form?.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                            <FormControlLabel control={<Switch checked={form?.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} />} label="Active" />
                        </Box>
                    </CapGate>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setForm(null)}>Cancel</Button>
                    <CapGate cap="admin.staff.edit">
                        <Button variant="contained" onClick={async () => {
                            try { await saveStaff(form); setForm(null); invalidate(); } catch (err) { setError(err.message); }
                        }}>Save</Button>
                    </CapGate>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
