import React, { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { bankAccount, canEditSetup, refreshAdminState, saveBank } from '../api.js';

/** Bank fields for Society profile (not a standalone nav page). */
export default function BankSection() {
    const canEdit = canEditSetup();
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState(null);

    const q = useQuery({
        queryKey: ['admin-bank'],
        queryFn: async () => {
            await refreshAdminState();
            const b = bankAccount();
            setForm({
                bank_name: b.bank_name || '',
                branch: b.branch || '',
                account_holder: b.account_holder || '',
                account_number: b.account_number || '',
                ifsc: b.ifsc || '',
                upi_id: b.upi_id || '',
                notes: b.notes || '',
                opening_balance_date: b.opening_balance_date || '',
                opening_balance: b.opening_balance ?? '',
                updated_at: b.updated_at || '',
            });
            return b;
        },
    });

    const f = form || {};
    const set = (k) => (e) => setForm({ ...f, [k]: e.target.value });

    return (
        <Paper sx={{ p: 2.5, mb: 2 }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5, gap: 1 }}>
                <Box>
                    <Typography variant="subtitle1" fontWeight={700}>Bank account</Typography>
                    <Typography variant="body2" color="text.secondary">
                        Official account for collections, vendor payments, and reconciliation.
                    </Typography>
                </Box>
                {canEdit ? (
                    <Button
                        variant="contained"
                        size="small"
                        startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                        disabled={saving || q.isLoading || !form}
                        onClick={async () => {
                            setError('');
                            setSaving(true);
                            try {
                                await saveBank(f);
                                await q.refetch();
                            } catch (err) { setError(err.message); }
                            finally { setSaving(false); }
                        }}
                    >
                        Save bank
                    </Button>
                ) : null}
            </Stack>
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {q.isLoading || !form ? <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}><CircularProgress size={22} /></Box> : (
                <>
                    <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.6 }}>Account details</Typography>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField label="Bank name" size="small" value={f.bank_name} onChange={set('bank_name')} disabled={!canEdit} />
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                            <TextField label="Branch" size="small" fullWidth value={f.branch} onChange={set('branch')} disabled={!canEdit} />
                            <TextField label="Account holder" size="small" fullWidth value={f.account_holder} onChange={set('account_holder')} disabled={!canEdit} />
                        </Stack>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                            <TextField label="Account number" size="small" fullWidth value={f.account_number} onChange={set('account_number')} disabled={!canEdit} />
                            <TextField label="IFSC" size="small" fullWidth value={f.ifsc} onChange={set('ifsc')} disabled={!canEdit} />
                        </Stack>
                        <TextField label="UPI ID (optional)" size="small" value={f.upi_id} onChange={set('upi_id')} disabled={!canEdit} />
                        <TextField label="Notes" size="small" multiline minRows={2} value={f.notes} onChange={set('notes')} disabled={!canEdit} />
                    </Stack>
                    <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 3, letterSpacing: 0.6 }}>Opening balance</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Passbook baseline used by bank reconciliation.</Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField label="Opening balance date" type="date" size="small" slotProps={{ inputLabel: { shrink: true } }} value={f.opening_balance_date} onChange={set('opening_balance_date')} disabled={!canEdit} />
                        <TextField label="Opening balance (₹)" type="number" size="small" value={f.opening_balance} onChange={set('opening_balance')} disabled={!canEdit} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                        {f.updated_at ? `Last updated ${new Date(f.updated_at).toLocaleString('en-IN')}` : 'No bank account saved yet for this society.'}
                    </Typography>
                </>
            )}
        </Paper>
    );
}
