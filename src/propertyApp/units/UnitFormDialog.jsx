import React, { useEffect, useState } from 'react';
import {
    Alert,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    Stack,
    TextField,
} from '@mui/material';
import { OCCUPANCY_STATUS_VALUES, occupancyLabel, createUnit, saveUnitFields } from './api.js';

const empty = {
    number: '',
    block: '',
    bhk: '',
    area_sqft: '',
    car_limit: 1,
    bike_limit: 1,
    occupancy_status: '',
    notes: '',
};

export default function UnitFormDialog({ open, onClose, unit, onSaved }) {
    const [form, setForm] = useState(empty);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        setError('');
        if (unit) {
            setForm({
                number: unit.number || '',
                block: unit.block || '',
                bhk: unit.bhk || '',
                area_sqft: unit.area_sqft ?? '',
                car_limit: unit.car_limit ?? 0,
                bike_limit: unit.bike_limit ?? 0,
                occupancy_status: unit.occupancy_status || unit.occupancy || '',
                notes: unit.notes || '',
            });
        } else {
            setForm(empty);
        }
    }, [open, unit]);

    const setField = (k, v) => setForm((p) => ({ ...p, [k]: v }));

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            const patch = {
                block: form.block || null,
                bhk: form.bhk || null,
                area_sqft: form.area_sqft === '' ? null : Number(form.area_sqft),
                car_limit: Number(form.car_limit) || 0,
                bike_limit: Number(form.bike_limit) || 0,
                occupancy_status: form.occupancy_status || null,
                notes: form.notes || null,
            };
            if (unit?.id) await saveUnitFields(unit.id, patch);
            else await createUnit({ ...patch, number: form.number });
            onSaved?.();
            onClose?.();
        } catch (err) {
            setError(err?.message || 'Save failed.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md" scroll="paper">
            <DialogTitle>{unit ? `Edit ${unit.number}` : 'Add flat'}</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 1 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <TextField
                        label="Flat number"
                        required
                        value={form.number}
                        disabled={Boolean(unit)}
                        onChange={(e) => setField('number', e.target.value.toUpperCase())}
                    />
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField label="Block" fullWidth value={form.block} onChange={(e) => setField('block', e.target.value)} />
                        <TextField label="BHK / type" fullWidth value={form.bhk} onChange={(e) => setField('bhk', e.target.value)} />
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField label="Area (sq ft)" fullWidth value={form.area_sqft} onChange={(e) => setField('area_sqft', e.target.value)} />
                        <TextField label="Car slots" type="number" fullWidth value={form.car_limit} onChange={(e) => setField('car_limit', e.target.value)} />
                        <TextField label="Bike slots" type="number" fullWidth value={form.bike_limit} onChange={(e) => setField('bike_limit', e.target.value)} />
                    </Stack>
                    <FormControl fullWidth>
                        <InputLabel>Occupancy</InputLabel>
                        <Select
                            label="Occupancy"
                            value={form.occupancy_status || ''}
                            onChange={(e) => setField('occupancy_status', e.target.value)}
                        >
                            <MenuItem value="">Derived from residents</MenuItem>
                            {OCCUPANCY_STATUS_VALUES.map((k) => (
                                <MenuItem key={k} value={k}>{occupancyLabel(k)}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField label="Notes" multiline minRows={2} value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={saving}>Cancel</Button>
                <Button variant="contained" onClick={handleSave} disabled={saving || (!unit && !form.number)}>
                    {saving ? <CircularProgress size={18} /> : 'Save'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
