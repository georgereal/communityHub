import React, { useEffect, useState } from 'react';
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    TextField,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
    FormControlLabel,
    Checkbox,
    Stack,
    Alert,
    CircularProgress,
    Autocomplete,
} from '@mui/material';
import { getUnitOptions, saveResident } from '../api.js';

const emptyForm = {
    unit_number: '',
    kind: 'OWNER',
    full_name: '',
    phone: '',
    email: '',
    notes: '',
    is_primary: false,
    is_residing: true,
};

export default function ResidentFormDialog({
    open,
    onClose,
    resident = null,
    onSaved,
    lockUnit = '',
    presetKind = '',
}) {
    const [form, setForm] = useState(emptyForm);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const units = getUnitOptions();

    useEffect(() => {
        if (!open) return;
        setError('');
        if (resident) {
            setForm({
                unit_number: resident.unit_number || '',
                kind: (resident.kind || 'OWNER').toUpperCase(),
                full_name: resident.full_name || '',
                phone: resident.phone || '',
                email: resident.email || '',
                notes: resident.notes || '',
                is_primary: !!resident.is_primary,
                is_residing: resident.is_residing !== false,
            });
        } else {
            setForm({
                ...emptyForm,
                unit_number: lockUnit || '',
                kind: (presetKind || 'OWNER').toUpperCase(),
            });
        }
    }, [open, resident, lockUnit, presetKind]);

    const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            await saveResident(form, resident?.id || null);
            onSaved?.();
            onClose?.();
        } catch (err) {
            setError(err?.message || 'Save failed.');
        } finally {
            setSaving(false);
        }
    };

    const isTenant = form.kind === 'TENANT';

    return (
        <Dialog
            open={open}
            onClose={saving ? undefined : onClose}
            fullWidth
            maxWidth="md"
            scroll="paper"
            slotProps={{ paper: { sx: { maxHeight: '90vh' } } }}
        >
            <DialogTitle>{resident ? 'Edit resident' : 'Add resident'}</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 1 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Autocomplete
                        options={units.map((u) => u.number)}
                        value={form.unit_number || null}
                        onChange={(_, v) => setField('unit_number', v || '')}
                        freeSolo
                        disabled={Boolean(lockUnit)}
                        renderInput={(params) => (
                            <TextField {...params} label="Flat / unit" required />
                        )}
                    />
                    <FormControl fullWidth>
                        <InputLabel id="res-kind-label">Kind</InputLabel>
                        <Select
                            labelId="res-kind-label"
                            label="Kind"
                            value={form.kind}
                            onChange={(e) => {
                                const kind = e.target.value;
                                setForm((prev) => ({
                                    ...prev,
                                    kind,
                                    is_residing: kind === 'TENANT' ? true : prev.is_residing,
                                }));
                            }}
                        >
                            <MenuItem value="OWNER">Owner</MenuItem>
                            <MenuItem value="TENANT">Tenant</MenuItem>
                        </Select>
                    </FormControl>
                    <TextField
                        label="Full name"
                        required
                        value={form.full_name}
                        onChange={(e) => setField('full_name', e.target.value)}
                    />
                    <TextField
                        label="Phone"
                        value={form.phone}
                        onChange={(e) => setField('phone', e.target.value)}
                    />
                    <TextField
                        label="Email"
                        type="email"
                        value={form.email}
                        onChange={(e) => setField('email', e.target.value)}
                    />
                    <TextField
                        label="Notes"
                        multiline
                        minRows={2}
                        value={form.notes}
                        onChange={(e) => setField('notes', e.target.value)}
                    />
                    <FormControlLabel
                        control={(
                            <Checkbox
                                checked={form.is_primary}
                                onChange={(e) => setField('is_primary', e.target.checked)}
                            />
                        )}
                        label="Primary contact for this flat"
                    />
                    {!isTenant ? (
                        <FormControlLabel
                            control={(
                                <Checkbox
                                    checked={form.is_residing}
                                    onChange={(e) => setField('is_residing', e.target.checked)}
                                />
                            )}
                            label="Owner residing in the flat"
                        />
                    ) : null}
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={onClose} disabled={saving}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={handleSave}
                    disabled={saving || !form.unit_number.trim() || !form.full_name.trim()}
                    startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
                >
                    {resident ? 'Save changes' : 'Add resident'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
