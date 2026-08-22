import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    Divider, IconButton, MenuItem, Stack, Tab, Tabs, TextField, Typography,
} from '@mui/material';
import { Close as CloseIcon, History as HistoryIcon, Save as SaveIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import CapGate from '../../components/CapGate.jsx';
import {
    fetchSpreadsheetSyncBoot,
    saveSpreadsheetOAuthApp,
    saveSpreadsheetSettings,
} from '../../spreadsheetSyncApi.js';

function fmtWhen(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return String(iso);
    }
}

function oauthAppFor(boot, provider) {
    return (boot?.ledgerOAuthApps || []).find((a) => a.provider === provider) || null;
}

/**
 * New Admin spreadsheet sync editor — Mongo only (no classic panel / portalState bridge).
 */
export default function SpreadsheetSyncDialog({ open, onClose }) {
    const qc = useQueryClient();
    const navigate = useNavigate();
    const [provider, setProvider] = useState('MICROSOFT');
    const [error, setError] = useState('');
    const [savingOauth, setSavingOauth] = useState(false);
    const [savingBook, setSavingBook] = useState(false);

    const bootQ = useQuery({
        queryKey: ['admin-spreadsheet-boot'],
        queryFn: fetchSpreadsheetSyncBoot,
        enabled: open,
    });

    const boot = bootQ.data;
    const app = oauthAppFor(boot, provider);
    const settings = boot?.ledgerSyncSettings;
    const myConn = (boot?.myOAuthConnections || []).find((c) => c.provider === provider);

    const [oauthForm, setOauthForm] = useState({
        client_id: '',
        tenant_id: 'common',
        client_secret: '',
    });
    const [bookForm, setBookForm] = useState({
        provider: 'MICROSOFT',
        spreadsheet_url: '',
        sheet_name: 'Transactions',
        range_a1: 'A:H',
        header_row: '',
        footer_row: '',
        sync_interval_minutes: 0,
    });

    useEffect(() => {
        if (!boot) return;
        const a = oauthAppFor(boot, provider);
        setOauthForm({
            client_id: a?.client_id || '',
            tenant_id: a?.tenant_id || 'common',
            client_secret: '',
        });
    }, [boot, provider]);

    useEffect(() => {
        if (!boot) return;
        const s = boot.ledgerSyncSettings;
        const prov = s?.provider && s.provider !== 'NONE' ? s.provider : provider;
        setBookForm({
            provider: prov === 'GOOGLE' || prov === 'MICROSOFT' ? prov : provider,
            spreadsheet_url: s?.spreadsheet_url || '',
            sheet_name: s?.sheet_name || 'Transactions',
            range_a1: s?.range_a1 || 'A:H',
            header_row: s?.header_row != null ? String(s.header_row) : '',
            footer_row: s?.footer_row != null ? String(s.footer_row) : '',
            sync_interval_minutes: Number(s?.sync_interval_minutes) || 0,
        });
        if (s?.provider === 'GOOGLE' || s?.provider === 'MICROSOFT') {
            setProvider(s.provider);
        }
    }, [boot]);

    const redirectHint = useMemo(() => {
        try {
            const origin = window.location.origin;
            return provider === 'MICROSOFT'
                ? `${origin}/microsoft-auth.html`
                : `${origin}/`;
        } catch {
            return '';
        }
    }, [provider]);

    const saveOauth = async () => {
        setError('');
        setSavingOauth(true);
        try {
            if (!oauthForm.client_id.trim()) throw new Error('Client ID is required.');
            await saveSpreadsheetOAuthApp({
                provider,
                client_id: oauthForm.client_id.trim(),
                tenant_id: oauthForm.tenant_id.trim() || 'common',
                client_secret: oauthForm.client_secret.trim(),
                redirect_uri: redirectHint || null,
            });
            setOauthForm((f) => ({ ...f, client_secret: '' }));
            await qc.invalidateQueries({ queryKey: ['admin-spreadsheet-boot'] });
            await qc.invalidateQueries({ queryKey: ['admin-integrations'] });
        } catch (err) {
            setError(err.message || 'Save failed.');
        } finally {
            setSavingOauth(false);
        }
    };

    const saveBook = async () => {
        setError('');
        setSavingBook(true);
        try {
            if (!bookForm.spreadsheet_url.trim()) throw new Error('Spreadsheet URL is required.');
            await saveSpreadsheetSettings({
                provider: bookForm.provider,
                spreadsheet_url: bookForm.spreadsheet_url.trim(),
                sheet_name: bookForm.sheet_name.trim() || 'Transactions',
                range_a1: bookForm.range_a1.trim() || 'A:H',
                header_row: bookForm.header_row ? Number(bookForm.header_row) : null,
                footer_row: bookForm.footer_row ? Number(bookForm.footer_row) : null,
                sync_interval_minutes: Number(bookForm.sync_interval_minutes) || 0,
            });
            await qc.invalidateQueries({ queryKey: ['admin-spreadsheet-boot'] });
            await qc.invalidateQueries({ queryKey: ['admin-integrations'] });
        } catch (err) {
            setError(err.message || 'Save failed.');
        } finally {
            setSavingBook(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                Ledger spreadsheet sync
                <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
                    <CloseIcon />
                </IconButton>
            </DialogTitle>
            <DialogContent dividers>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Configure OAuth and the workbook link stored in Mongo. Live pull/push sync actions stay on Finance for now.
                </Typography>

                {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
                {bootQ.isLoading ? (
                    <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}><CircularProgress /></Box>
                ) : bootQ.isError ? (
                    <Alert severity="error">{bootQ.error?.message || 'Failed to load.'}</Alert>
                ) : (
                    <Stack spacing={3}>
                        <Box>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap', gap: 1 }}>
                                <Typography variant="subtitle2" fontWeight={700}>Last sync</Typography>
                                {settings?.last_sync_status ? (
                                    <Chip size="small" label={settings.last_sync_status} color={settings.last_sync_status === 'OK' ? 'success' : 'warning'} />
                                ) : (
                                    <Chip size="small" label="Never" variant="outlined" />
                                )}
                            </Stack>
                            <Typography variant="body2" color="text.secondary">
                                {fmtWhen(settings?.last_synced_at)}
                                {settings?.last_sync_message ? ` — ${settings.last_sync_message}` : ''}
                            </Typography>
                            <Button
                                size="small"
                                startIcon={<HistoryIcon />}
                                sx={{ mt: 1 }}
                                onClick={() => {
                                    onClose?.();
                                    navigate('/activity?tab=spreadsheet');
                                }}
                            >
                                View spreadsheet runs
                            </Button>
                            {(boot?.myOAuthConnections || []).length ? (
                                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                                    Connected accounts:{' '}
                                    {(boot.myOAuthConnections || []).map((c) => `${c.provider}: ${c.account_email || 'linked'}`).join(' · ')}
                                </Typography>
                            ) : null}
                        </Box>

                        <Divider />

                        <Tabs
                            value={provider}
                            onChange={(_e, v) => setProvider(v)}
                            variant="fullWidth"
                        >
                            <Tab value="MICROSOFT" label="Excel Online" />
                            <Tab value="GOOGLE" label="Google Sheets" />
                        </Tabs>

                        <Box>
                            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
                                {provider === 'MICROSOFT' ? 'Azure app' : 'Google OAuth app'}
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                Society-level app registration. Redirect URI: <code>{redirectHint}</code>
                                {app?.client_secret_set ? ' · Client secret on file' : ''}
                            </Typography>
                            <CapGate cap="admin.integrations.edit" mode="disable">
                            <Stack spacing={2}>
                                <TextField
                                    label="Client ID"
                                    size="small"
                                    value={oauthForm.client_id}
                                    onChange={(e) => setOauthForm({ ...oauthForm, client_id: e.target.value })}
                                    fullWidth
                                />
                                {provider === 'MICROSOFT' ? (
                                    <TextField
                                        label="Tenant ID"
                                        size="small"
                                        value={oauthForm.tenant_id}
                                        onChange={(e) => setOauthForm({ ...oauthForm, tenant_id: e.target.value })}
                                        fullWidth
                                    />
                                ) : null}
                                <TextField
                                    label="Client secret"
                                    type="password"
                                    size="small"
                                    value={oauthForm.client_secret}
                                    onChange={(e) => setOauthForm({ ...oauthForm, client_secret: e.target.value })}
                                    fullWidth
                                    placeholder={app?.client_secret_set ? 'Leave blank to keep current' : 'Required for background sync'}
                                    helperText={myConn?.account_email ? `Your linked account: ${myConn.account_email}` : 'Connect a user account from Finance after saving the app.'}
                                />
                                <CapGate cap="admin.integrations.edit">
                                    <Box>
                                        <Button
                                            variant="contained"
                                            size="small"
                                            startIcon={savingOauth ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                                            disabled={savingOauth}
                                            onClick={() => void saveOauth()}
                                        >
                                            Save OAuth app
                                        </Button>
                                    </Box>
                                </CapGate>
                            </Stack>
                            </CapGate>
                        </Box>

                        <Divider />

                        <Box>
                            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>Workbook</Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                Spreadsheet URL and sheet bounds used for ledger sync.
                            </Typography>
                            <CapGate any={['admin.integrations.sync', 'admin.integrations.edit']} mode="disable">
                            <Stack spacing={2}>
                                <TextField
                                    select
                                    label="Provider"
                                    size="small"
                                    value={bookForm.provider}
                                    onChange={(e) => setBookForm({ ...bookForm, provider: e.target.value })}
                                    fullWidth
                                >
                                    <MenuItem value="MICROSOFT">Microsoft Excel Online</MenuItem>
                                    <MenuItem value="GOOGLE">Google Sheets</MenuItem>
                                </TextField>
                                <TextField
                                    label="Spreadsheet URL"
                                    size="small"
                                    value={bookForm.spreadsheet_url}
                                    onChange={(e) => setBookForm({ ...bookForm, spreadsheet_url: e.target.value })}
                                    fullWidth
                                />
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                    <TextField
                                        label="Sheet / tab name"
                                        size="small"
                                        value={bookForm.sheet_name}
                                        onChange={(e) => setBookForm({ ...bookForm, sheet_name: e.target.value })}
                                        fullWidth
                                    />
                                    <TextField
                                        label="Column range"
                                        size="small"
                                        value={bookForm.range_a1}
                                        onChange={(e) => setBookForm({ ...bookForm, range_a1: e.target.value })}
                                        fullWidth
                                    />
                                </Stack>
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                    <TextField
                                        label="Header row"
                                        size="small"
                                        type="number"
                                        value={bookForm.header_row}
                                        onChange={(e) => setBookForm({ ...bookForm, header_row: e.target.value })}
                                        fullWidth
                                    />
                                    <TextField
                                        label="Totals row"
                                        size="small"
                                        type="number"
                                        value={bookForm.footer_row}
                                        onChange={(e) => setBookForm({ ...bookForm, footer_row: e.target.value })}
                                        fullWidth
                                    />
                                    <TextField
                                        label="Auto-sync (minutes)"
                                        size="small"
                                        type="number"
                                        value={bookForm.sync_interval_minutes}
                                        onChange={(e) => setBookForm({ ...bookForm, sync_interval_minutes: e.target.value })}
                                        fullWidth
                                        helperText="0 = manual only"
                                    />
                                </Stack>
                                <CapGate any={['admin.integrations.sync', 'admin.integrations.edit']}>
                                    <Box>
                                        <Button
                                            variant="contained"
                                            size="small"
                                            startIcon={savingBook ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                                            disabled={savingBook}
                                            onClick={() => void saveBook()}
                                        >
                                            Save workbook
                                        </Button>
                                    </Box>
                                </CapGate>
                            </Stack>
                            </CapGate>
                        </Box>
                    </Stack>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
