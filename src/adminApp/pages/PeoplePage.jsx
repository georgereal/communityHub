import React, { useMemo, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    IconButton, MenuItem, Paper, Stack, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { Add as AddIcon, Check as CheckIcon, Close as CloseIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';
import {
    approveRequest, assignUserAccess, canEditSetup, denyRequest,
    loadPeopleDirectory, ROLE_OPTIONS, userDisplayRole,
} from '../api.js';
import { portalState } from '../../store.js';
import { isSocietyAdminUser } from '../../rbac.js';

const COLS = [
    { key: 'name', label: 'User', canSort: true, canFilter: true },
    { key: 'role', label: 'Primary role', canSort: true, canFilter: true },
    { key: 'access', label: 'Status', canSort: true, canFilter: true },
];

export default function PeoplePage() {
    const qc = useQueryClient();
    const canEdit = canEditSetup() && isSocietyAdminUser();
    const [filter, setFilter] = useState({ name: '', role: '', access: '' });
    const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
    const [error, setError] = useState('');
    const [form, setForm] = useState(null);

    const usersQ = useQuery({
        queryKey: ['admin-people'],
        queryFn: () => loadPeopleDirectory(),
    });

    const users = usersQ.data?.users || [];
    const requests = usersQ.data?.requests || [];
    const apts = portalState.access?.apartments || [];
    const activeId = portalState.access?.activeApartmentId;

    const rows = useMemo(() => sortAndFilterRows(users, {
        filters: filter,
        sort,
        getText: (u, key) => {
            if (key === 'name') return `${u.name || ''} ${u.email || ''}`;
            if (key === 'role') return userDisplayRole(u);
            if (key === 'access') return 'Approved';
        },
    }), [users, filter, sort, apts]);

    const cards = [
        { key: 'users', label: 'Approved', value: users.length, tone: 'owner', hint: 'People with access to this society' },
        { key: 'requests', label: 'Pending requests', value: requests.length, tone: requests.length ? 'warn' : 'default' },
    ];

    const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-people'] });

    const submitAssign = async () => {
        setError('');
        try {
            await assignUserAccess({
                email: form.email,
                name: form.name,
                roleKey: form.roleKey,
                apartmentIds: form.apartmentIds,
            });
            setForm(null);
            invalidate();
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="People & access"
                subtitle="Approved members of this society. Pending sign-in requests appear above the list."
                actions={(
                    <>
                        <Tooltip title="Refresh">
                            <IconButton size="small" onClick={invalidate} disabled={usersQ.isFetching}>
                                {usersQ.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                        {canEdit ? (
                            <Button
                                variant="contained"
                                size="small"
                                startIcon={<AddIcon />}
                                onClick={() => setForm({
                                    name: '',
                                    email: '',
                                    roleKey: 'resident_viewer',
                                    apartmentIds: activeId ? [activeId] : [],
                                })}
                            >
                                Assign
                            </Button>
                        ) : null}
                    </>
                )}
            />

            <SummaryStrip cards={cards} activeKey="users" />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {usersQ.error ? <Alert severity="error" sx={{ mb: 2 }}>{usersQ.error.message}</Alert> : null}

            {requests.length ? (
                <Paper sx={{ p: 2, mb: 2, borderColor: 'error.light' }}>
                    <Typography fontWeight={700} sx={{ mb: 1 }}>Access requests</Typography>
                    <Stack spacing={1}>
                        {requests.map((r) => (
                            <Stack key={r.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
                                <Box>
                                    <Typography fontWeight={600}>{r.requester_name || r.requester_email || r.user_id}</Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        {r.requester_email} · {r.request_kind === 'office' ? 'Office staff' : 'Resident'}
                                        {r.message ? ` · ${r.message}` : ''}
                                    </Typography>
                                </Box>
                                {canEdit ? (
                                    <Stack direction="row" spacing={0.5}>
                                        <Button size="small" startIcon={<CheckIcon />} onClick={async () => {
                                            try {
                                                await approveRequest(r, r.request_kind === 'office' ? 'office_staff' : 'resident_viewer');
                                                invalidate();
                                            } catch (err) { setError(err.message); }
                                        }}>Approve</Button>
                                        <Button size="small" color="error" startIcon={<CloseIcon />} onClick={async () => {
                                            try {
                                                await denyRequest(r);
                                                invalidate();
                                            } catch (err) { setError(err.message); }
                                        }}>Deny</Button>
                                    </Stack>
                                ) : null}
                            </Stack>
                        ))}
                    </Stack>
                </Paper>
            ) : null}

            {usersQ.isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : (
                <TableContainer component={Paper}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                {COLS.map((col) => (
                                    <TableCell key={col.key}>
                                        <ExcelColHeader
                                            col={col}
                                            sort={sort}
                                            filterValue={filter[col.key]}
                                            onSort={(key) => setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }))}
                                            onFilter={(v) => setFilter((f) => ({ ...f, [col.key]: v }))}
                                            onClear={() => setFilter((f) => ({ ...f, [col.key]: '' }))}
                                        />
                                    </TableCell>
                                ))}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.length ? rows.map((u) => (
                                <TableRow key={u.id} hover onClick={() => canEdit && setForm({
                                    name: u.name || '',
                                    email: u.email || '',
                                    roleKey: u.role || 'resident_viewer',
                                    apartmentIds: u.apartment_ids || [],
                                })} sx={{ cursor: canEdit ? 'pointer' : 'default' }}>
                                    <TableCell>
                                        <Typography fontWeight={600}>{u.name || '—'}</Typography>
                                        <Typography variant="caption" color="text.secondary">{u.email}</Typography>
                                    </TableCell>
                                    <TableCell>{userDisplayRole(u)}</TableCell>
                                    <TableCell>
                                        <Chip size="small" color="success" label="Approved" />
                                    </TableCell>
                                </TableRow>
                            )) : (
                                <TableRow><TableCell colSpan={3}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No approved members for this society yet.</Typography></TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            <Dialog open={Boolean(form)} onClose={() => setForm(null)} fullWidth maxWidth="sm">
                <DialogTitle>Assign access</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField label="Name" size="small" value={form?.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                        <TextField label="Email" size="small" value={form?.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                        <TextField select label="Role" size="small" value={form?.roleKey || 'resident_viewer'} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
                            {ROLE_OPTIONS.filter((r) => r.scope !== 'system' || isSocietyAdminUser()).map((r) => (
                                <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            select
                            label="Societies"
                            size="small"
                            slotProps={{ select: { multiple: true } }}
                            value={form?.apartmentIds || []}
                            onChange={(e) => setForm({ ...form, apartmentIds: e.target.value })}
                        >
                            {apts.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                        </TextField>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setForm(null)}>Cancel</Button>
                    <Button variant="contained" onClick={submitAssign}>Save</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
