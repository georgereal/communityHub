import React, { useEffect, useState } from 'react';
import {
    Alert,
    Autocomplete,
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
import { listUnitOptions, saveVehicle } from './api.js';

export default function VehicleFormDialog({ open, onClose, vehicle, onSaved, lockUnitId = '' }) {
    const [unitId, setUnitId] = useState('');
    const [plate, setPlate] = useState('');
    const [type, setType] = useState('CAR');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const units = listUnitOptions();

    useEffect(() => {
        if (!open) return;
        setError('');
        setUnitId(vehicle?.unit_id || lockUnitId || '');
        setPlate(vehicle?.plate || '');
        setType((vehicle?.type || 'CAR').toUpperCase() === 'BIKE' ? 'BIKE' : 'CAR');
    }, [open, vehicle, lockUnitId]);

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            await saveVehicle({ unitId, plate, type }, vehicle);
            onSaved?.();
            onClose?.();
        } catch (err) {
            setError(err?.message || 'Save failed.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" scroll="paper">
            <DialogTitle>{vehicle ? 'Edit vehicle' : 'Add vehicle'}</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 1 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Autocomplete
                        options={units}
                        getOptionLabel={(o) => o.number || ''}
                        value={units.find((u) => u.id === unitId) || null}
                        onChange={(_, v) => setUnitId(v?.id || '')}
                        disabled={Boolean(vehicle) || Boolean(lockUnitId)}
                        renderInput={(params) => <TextField {...params} label="Flat" required />}
                    />
                    <TextField
                        label="Plate"
                        required
                        value={plate}
                        onChange={(e) => setPlate(e.target.value.toUpperCase())}
                    />
                    <FormControl fullWidth>
                        <InputLabel>Type</InputLabel>
                        <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                            <MenuItem value="CAR">Car</MenuItem>
                            <MenuItem value="BIKE">Bike</MenuItem>
                        </Select>
                    </FormControl>
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={saving}>Cancel</Button>
                <Button variant="contained" onClick={handleSave} disabled={saving || !plate || !unitId}>
                    {saving ? <CircularProgress size={18} /> : 'Save'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
