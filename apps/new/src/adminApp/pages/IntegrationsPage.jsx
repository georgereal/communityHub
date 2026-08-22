import React, { useMemo, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    FormControlLabel, IconButton, Paper, Switch, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
    Close as CloseIcon,
    Edit as EditIcon,
    History as HistoryIcon,
    Refresh as RefreshIcon,
    Save as SaveIcon,
    Visibility as ViewIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import SpreadsheetSyncDialog from './SpreadsheetSyncDialog.jsx';
import {
    canEditAccounts, canEditSetup, CONNECTION_CATALOG, loadConnections, saveConnection,
} from '../api.js';
import { getConnectionRow } from '../../externalConnections.js';
import { loadSpreadsheetSyncBoot, spreadsheetStatusFromBoot } from '../../spreadsheetSyncApi.js';
import { portalState } from '../../store.js';

/** Builtin integrations that are not Mongo external_connections rows. */
const BUILTIN_INTEGRATIONS = [
    {
        id: 'spreadsheet-sync',
        kind: 'spreadsheet',
        label: 'Ledger spreadsheet sync',
        description: 'Import and export the ledger via Google Sheets or Microsoft Excel Online.',
        icon: 'fa-file-excel',
    },
];

function connectionStatus(row, enabled) {
    if (!row?.api_key_set) return { key: 'missing', label: 'Not configured', tone: 'warning' };
    if (enabled === false || row.enabled === false) return { key: 'disabled', label: 'Disabled', tone: 'default' };
    return { key: 'ready', label: 'Configured', tone: 'success' };
}

function EvolyxEditForm({ def, canEdit, onClose, onSaved }) {
    const row = getConnectionRow(def.provider, def.connectionKey);
    const [form, setForm] = useState({
        base_url: row?.base_url || def.defaults.base_url,
        client_id: row?.client_id || def.defaults.client_id,
        webhook_base_url: row?.webhook_base_url || def.defaults.webhook_base_url || '',
        workflow_id: row?.workflow_id || def.defaults.workflow_id,
        api_key: '',
        enabled: row?.enabled !== false,
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    return (
        <>
            <DialogTitle sx={{ pr: 6 }}>
                {def.label}
                <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
                    <CloseIcon />
                </IconButton>
            </DialogTitle>
            <DialogContent dividers>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{def.description}</Typography>
                {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
                <Box sx={{ display: 'grid', gap: 2 }}>
                    <TextField
                        label="Evolyx API URL"
                        size="small"
                        value={form.base_url}
                        onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                        disabled={!canEdit}
                        helperText="Evolyx service endpoint — not this app’s URL."
                    />
                    <TextField label="Client ID" size="small" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} disabled={!canEdit} />
                    <TextField label="Workflow ID" size="small" value={form.workflow_id} onChange={(e) => setForm({ ...form, workflow_id: e.target.value })} disabled={!canEdit} />
                    <TextField
                        label="API key"
                        type="password"
                        size="small"
                        value={form.api_key}
                        onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                        disabled={!canEdit}
                        placeholder={row?.api_key_set ? 'Leave blank to keep current' : 'evx_…'}
                    />
                    <TextField
                        label="Webhook override URL (optional)"
                        size="small"
                        value={form.webhook_base_url}
                        onChange={(e) => setForm({ ...form, webhook_base_url: e.target.value })}
                        disabled={!canEdit}
                        placeholder="https://your-tunnel.example"
                        helperText="Leave blank to use this API server (recommended in production). For local tunnels, set the https origin so Evolyx can reach your machine."
                    />
                    <FormControlLabel
                        control={<Switch checked={form.enabled} disabled={!canEdit} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />}
                        label="Enabled"
                    />
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
                {canEdit ? (
                    <Button
                        variant="contained"
                        startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                        disabled={saving}
                        onClick={async () => {
                            setError('');
                            setSaving(true);
                            try {
                                const apartment_id = portalState.access?.activeApartmentId;
                                if (!form.base_url.trim()) throw new Error('API base URL is required.');
                                if (!form.api_key && !row?.api_key_set) throw new Error('API key is required for a new connection.');
                                await saveConnection({
                                    apartment_id,
                                    provider: def.provider,
                                    connection_key: def.connectionKey,
                                    display_name: def.label,
                                    base_url: form.base_url.trim(),
                                    client_id: form.client_id.trim() || null,
                                    webhook_base_url: form.webhook_base_url.trim() || null,
                                    workflow_id: form.workflow_id.trim() || null,
                                    enabled: form.enabled,
                                    api_key: form.api_key || '',
                                });
                                onSaved?.();
                                onClose();
                            } catch (err) {
                                setError(err.message);
                            } finally {
                                setSaving(false);
                            }
                        }}
                    >
                        Save connection
                    </Button>
                ) : null}
            </DialogActions>
        </>
    );
}

function statusChip(status) {
    const color = status.tone === 'success' ? 'success' : status.tone === 'warning' ? 'warning' : 'default';
    return <Chip size="small" label={status.label} color={color} variant={color === 'default' ? 'outlined' : 'filled'} />;
}

export default function IntegrationsPage() {
    const qc = useQueryClient();
    const navigate = useNavigate();
    const canEdit = canEditSetup();
    const canSync = canEditAccounts() || canEdit;
    const [error, setError] = useState('');
    const [activeFilter, setActiveFilter] = useState('');
    const [evolyxDef, setEvolyxDef] = useState(null);
    const [spreadsheetOpen, setSpreadsheetOpen] = useState(false);

    const q = useQuery({
        queryKey: ['admin-integrations'],
        queryFn: async () => {
            const [, sheetBoot] = await Promise.all([
                loadConnections(),
                loadSpreadsheetSyncBoot().catch((err) => {
                    console.warn('[admin integrations] spreadsheet boot', err);
                    return null;
                }),
            ]);
            return { sheetBoot };
        },
    });

    const items = useMemo(() => {
        const apiItems = CONNECTION_CATALOG.map((def) => {
            const row = getConnectionRow(def.provider, def.connectionKey);
            const status = connectionStatus(row, row?.enabled);
            return {
                id: `${def.provider}:${def.connectionKey}`,
                kind: 'api',
                def,
                label: def.label,
                description: def.description,
                typeLabel: 'API connection',
                status,
                canOpen: true,
                canEdit: canEdit,
            };
        });
        const sheetStatus = spreadsheetStatusFromBoot(q.data?.sheetBoot);
        const builtins = BUILTIN_INTEGRATIONS.map((b) => ({
            id: b.id,
            kind: b.kind,
            label: b.label,
            description: b.description,
            typeLabel: 'Spreadsheet',
            status: sheetStatus,
            canOpen: canSync,
            canEdit: canSync,
        }));
        return [...apiItems, ...builtins];
    }, [q.data, canEdit, canSync, q.dataUpdatedAt]);

    const filtered = useMemo(() => {
        if (!activeFilter) return items;
        if (activeFilter === 'ready') return items.filter((i) => i.status.key === 'ready');
        if (activeFilter === 'missing') return items.filter((i) => i.status.key === 'missing');
        if (activeFilter === 'disabled') return items.filter((i) => i.status.key === 'disabled');
        return items;
    }, [items, activeFilter]);

    const cards = [
        { key: '', label: 'All', value: items.length, tone: 'default' },
        { key: 'ready', label: 'Configured', value: items.filter((i) => i.status.key === 'ready').length, tone: 'owner' },
        { key: 'missing', label: 'Not configured', value: items.filter((i) => i.status.key === 'missing').length, tone: 'tenant' },
        { key: 'disabled', label: 'Disabled', value: items.filter((i) => i.status.key === 'disabled').length, tone: 'default' },
    ];

    const openItem = (item) => {
        setError('');
        if (item.kind === 'spreadsheet') {
            if (!canSync) {
                setError('You need accounts or setup edit permission to manage spreadsheet sync.');
                return;
            }
            setSpreadsheetOpen(true);
            return;
        }
        setEvolyxDef(item.def);
    };

    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['admin-integrations'] });
        qc.invalidateQueries({ queryKey: ['admin-spreadsheet-boot'] });
    };

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Integrations"
                subtitle="Connect external services for this society. Open a row to view or edit details."
                actions={(
                    <>
                        <Tooltip title="Activity">
                            <IconButton
                                size="small"
                                onClick={() => navigate('/activity')}
                                aria-label="Activity"
                            >
                                <HistoryIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Refresh">
                            <IconButton size="small" onClick={invalidate} aria-label="Refresh">
                                {q.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                    </>
                )}
            />
            <SummaryStrip
                cards={cards}
                activeKey={activeFilter}
                onSelect={(key) => setActiveFilter(key || '')}
            />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {q.isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : (
                <TableContainer component={Paper}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>Integration</TableCell>
                                <TableCell>Type</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell align="right">Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {filtered.length ? filtered.map((item) => (
                                <TableRow key={item.id} hover sx={{ cursor: item.canOpen ? 'pointer' : 'default' }} onClick={() => item.canOpen && openItem(item)}>
                                    <TableCell>
                                        <Typography fontWeight={600}>{item.label}</Typography>
                                        <Typography variant="body2" color="text.secondary">{item.description}</Typography>
                                    </TableCell>
                                    <TableCell>{item.typeLabel}</TableCell>
                                    <TableCell>
                                        {statusChip(item.status)}
                                        {item.status.detail ? (
                                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                                                {item.status.detail}
                                            </Typography>
                                        ) : null}
                                    </TableCell>
                                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                        {item.canOpen ? (
                                            <Tooltip title={item.canEdit ? 'Edit' : 'View'}>
                                                <IconButton size="small" onClick={() => openItem(item)} aria-label={item.canEdit ? 'Edit' : 'View'}>
                                                    {item.canEdit ? <EditIcon fontSize="small" /> : <ViewIcon fontSize="small" />}
                                                </IconButton>
                                            </Tooltip>
                                        ) : (
                                            <Typography variant="caption" color="text.secondary">No access</Typography>
                                        )}
                                    </TableCell>
                                </TableRow>
                            )) : (
                                <TableRow>
                                    <TableCell colSpan={4}>
                                        <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                                            No integrations match this filter.
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            <Dialog open={Boolean(evolyxDef)} onClose={() => setEvolyxDef(null)} fullWidth maxWidth="md" scroll="paper">
                {evolyxDef ? (
                    <EvolyxEditForm
                        def={evolyxDef}
                        canEdit={canEdit}
                        onClose={() => setEvolyxDef(null)}
                        onSaved={invalidate}
                    />
                ) : null}
            </Dialog>

            <SpreadsheetSyncDialog
                open={spreadsheetOpen}
                canEdit={canSync}
                onClose={() => {
                    setSpreadsheetOpen(false);
                    invalidate();
                }}
            />
        </Box>
    );
}
