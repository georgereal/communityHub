import React, { useEffect, useRef, useState } from 'react';
import {
    Alert, Box, Button, CircularProgress, FormControlLabel, Paper, Stack, Switch, TextField, Typography,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import {
    canEditAccounts, canEditSetup, CONNECTION_CATALOG, loadConnections, saveConnection,
} from '../api.js';
import { getConnectionRow } from '../../externalConnections.js';
import { renderAdminSyncPanel } from '../../ledgerSpreadsheetSync.js';
import { portalState } from '../../store.js';

function ConnectionCard({ def, canEdit, onSaved }) {
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
    const status = row?.api_key_set ? (form.enabled ? 'Configured' : 'Disabled') : 'Not configured';

    return (
        <Paper sx={{ p: 2.5, mb: 2 }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, gap: 1 }}>
                <Box>
                    <Typography variant="subtitle1" fontWeight={700}>{def.label}</Typography>
                    <Typography variant="body2" color="text.secondary">{def.description}</Typography>
                </Box>
                <Typography variant="caption" fontWeight={700} color={row?.api_key_set && form.enabled ? 'success.main' : 'warning.main'}>{status}</Typography>
            </Stack>
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            <Stack spacing={2}>
                <TextField label="Evolyx API URL" size="small" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} disabled={!canEdit} helperText="Evolyx service endpoint — not this app’s URL." />
                <TextField label="Client ID" size="small" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} disabled={!canEdit} />
                <TextField label="This app’s public URL" size="small" value={form.webhook_base_url} onChange={(e) => setForm({ ...form, webhook_base_url: e.target.value })} disabled={!canEdit} helperText="OCR callbacks go to {this URL}/api/passbook-webhook (public Evolyx callback)." />
                <TextField label="Workflow ID" size="small" value={form.workflow_id} onChange={(e) => setForm({ ...form, workflow_id: e.target.value })} disabled={!canEdit} />
                <TextField label="API key" type="password" size="small" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} disabled={!canEdit} placeholder={row?.api_key_set ? 'Leave blank to keep current' : 'evx_…'} />
                <FormControlLabel control={<Switch checked={form.enabled} disabled={!canEdit} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />} label="Enabled" />
            </Stack>
            {canEdit ? (
                <Button
                    sx={{ mt: 2 }}
                    variant="contained"
                    size="small"
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
                        } catch (err) { setError(err.message); }
                        finally { setSaving(false); }
                    }}
                >
                    Save connection
                </Button>
            ) : null}
        </Paper>
    );
}

export default function IntegrationsPage() {
    const canEdit = canEditSetup();
    const canSync = canEditAccounts() || canEdit;
    const host = useRef(null);

    const q = useQuery({
        queryKey: ['admin-connections'],
        queryFn: loadConnections,
    });

    useEffect(() => {
        if (!canSync || !host.current) return undefined;
        host.current.id = 'admin-sync-panel-container';
        try {
            renderAdminSyncPanel();
        } catch (err) {
            console.warn('[admin integrations] sync panel', err);
        }
        return undefined;
    }, [canSync, q.isFetched]);

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Integrations"
                subtitle="External API credentials and ledger spreadsheet sync for this society."
            />
            {q.isLoading ? <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}><CircularProgress /></Box> : (
                CONNECTION_CATALOG.map((def) => (
                    <ConnectionCard key={`${def.provider}-${def.connectionKey}`} def={def} canEdit={canEdit} onSaved={() => q.refetch()} />
                ))
            )}
            {canSync ? (
                <Paper sx={{ p: 2, mt: 1 }}>
                    <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>Spreadsheet sync</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Import and export the ledger via a linked spreadsheet.</Typography>
                    <div ref={host} />
                </Paper>
            ) : null}
        </Box>
    );
}
