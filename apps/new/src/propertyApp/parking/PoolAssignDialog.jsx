import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Autocomplete,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItem,
    ListItemText,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { portalState } from '../../store.js';
import {
    assignPoolSlot,
    canEditParking,
    firstOpenPoolSlot,
    listPoolSlots,
    listUnitOptions,
    releasePoolSlot,
    saveVehicle,
} from './api.js';

function occupantsFor(kind, q) {
    const query = String(q || '').trim().toLowerCase();
    return listPoolSlots(kind)
        .filter((s) => s.assigned_vehicle_id || s.occupant)
        .filter((s) => {
            if (!query) return true;
            const hay = `${s.name || ''} ${s.unit_num || ''} ${s.occupant || ''}`.toLowerCase();
            return hay.includes(query);
        });
}

function vehicleOnFlat(unitId, plate) {
    const unit = (portalState.units || []).find((u) => u.id === unitId);
    const want = String(plate || '').trim().toUpperCase();
    return (unit?.vehicles || []).find((v) => String(v.plate || '').toUpperCase() === want) || null;
}

export default function PoolAssignDialog({ open, kind = 'car', onClose, onSaved }) {
    const canEdit = canEditParking();
    const label = kind === 'bike' ? 'BH' : 'EH';
    const type = kind === 'bike' ? 'BIKE' : 'CAR';
    const flats = listUnitOptions();

    const [findQ, setFindQ] = useState('');
    const [plateEdits, setPlateEdits] = useState({});
    const [addPlate, setAddPlate] = useState('');
    const [addFlat, setAddFlat] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setFindQ('');
            setPlateEdits({});
            setAddPlate('');
            setAddFlat(null);
            setError('');
        }
    }, [open, kind]);

    const slots = listPoolSlots(kind);
    const taken = slots.filter((s) => s.assigned_vehicle_id || s.occupant);
    const openCount = slots.length - taken.length;
    const found = useMemo(() => occupantsFor(kind, findQ), [kind, findQ, open, taken.length]);

    const release = async (slot) => {
        setBusy(true);
        setError('');
        try {
            await releasePoolSlot(slot.id);
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not remove.');
        } finally {
            setBusy(false);
        }
    };

    const correctPlate = async (slot) => {
        const next = String(plateEdits[slot.id] ?? slot.occupant ?? '').trim().toUpperCase();
        if (!next || next === String(slot.occupant || '').toUpperCase()) return;
        let unit = (portalState.units || []).find((u) => u.number === slot.unit_num);
        let vehicle = (unit?.vehicles || []).find((v) => v.id === slot.assigned_vehicle_id);
        if (!vehicle && slot.assigned_vehicle_id) {
            (portalState.units || []).some((u) => {
                const hit = (u.vehicles || []).find((v) => v.id === slot.assigned_vehicle_id);
                if (hit) {
                    unit = u;
                    vehicle = hit;
                    return true;
                }
                return false;
            });
        }
        if (!unit || !vehicle) {
            setError('Could not find that vehicle on the flat.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            await saveVehicle({ unitId: unit.id, plate: next, type: vehicle.type || type }, vehicle);
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not update plate.');
        } finally {
            setBusy(false);
        }
    };

    const addToPool = async () => {
        const plate = addPlate.trim().toUpperCase();
        if (!plate || !addFlat?.id) {
            setError(`Enter a plate and pick the flat for this ${label} vehicle.`);
            return;
        }
        const slot = firstOpenPoolSlot(kind);
        if (!slot) {
            setError(`${label} is full (${slots.length} slots). Add a slot on the page first.`);
            return;
        }
        setBusy(true);
        setError('');
        try {
            let vehicle = vehicleOnFlat(addFlat.id, plate);
            if (!vehicle) {
                await saveVehicle({ unitId: addFlat.id, plate, type });
                vehicle = vehicleOnFlat(addFlat.id, plate);
            }
            if (!vehicle?.id) throw new Error('Vehicle was not saved.');
            await assignPoolSlot(slot.id, vehicle.id);
            setAddPlate('');
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not add.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                Edit {label} parking
                <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2.5} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Typography variant="body2" color="text.secondary">
                        {taken.length} of {slots.length} {label} slots used
                        {openCount ? ` · ${openCount} open` : ' · full'}.
                    </Typography>

                    <Stack spacing={1}>
                        <Typography fontWeight={700}>{label} assignments</Typography>
                        <TextField
                            size="small"
                            label="Filter plate or flat"
                            value={findQ}
                            onChange={(e) => setFindQ(e.target.value)}
                            fullWidth
                        />
                        {found.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                                {findQ.trim() ? `No ${label} vehicle matches.` : `No vehicles in ${label} yet.`}
                            </Typography>
                        ) : (
                            <List dense sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, maxHeight: 280, overflow: 'auto' }}>
                                {found.map((s) => (
                                    <ListItem
                                        key={s.id}
                                        alignItems="flex-start"
                                        sx={{ gap: 1, flexWrap: 'wrap' }}
                                        secondaryAction={canEdit ? (
                                            <Button size="small" color="error" disabled={busy} onClick={() => release(s)}>
                                                Remove
                                            </Button>
                                        ) : null}
                                    >
                                        <ListItemText
                                            primary={`${s.occupant || '—'} · ${s.unit_num || '—'}`}
                                            secondary={s.name}
                                            sx={{ pr: 8, minWidth: 160 }}
                                        />
                                        {canEdit ? (
                                            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', mt: 0.5 }}>
                                                <TextField
                                                    size="small"
                                                    label="Correct plate"
                                                    value={plateEdits[s.id] ?? s.occupant ?? ''}
                                                    onChange={(e) => setPlateEdits((prev) => ({ ...prev, [s.id]: e.target.value.toUpperCase() }))}
                                                    sx={{ flex: 1 }}
                                                />
                                                <Button size="small" disabled={busy} onClick={() => correctPlate(s)}>Save</Button>
                                            </Stack>
                                        ) : null}
                                    </ListItem>
                                ))}
                            </List>
                        )}
                    </Stack>

                    {canEdit ? (
                        <Stack spacing={1}>
                            <Typography fontWeight={700}>Add to {label}</Typography>
                            <Autocomplete
                                options={flats}
                                getOptionLabel={(o) => o.number || ''}
                                value={addFlat}
                                onChange={(_, v) => setAddFlat(v)}
                                renderInput={(params) => <TextField {...params} size="small" label="Flat" />}
                            />
                            <TextField
                                size="small"
                                label="Vehicle plate"
                                value={addPlate}
                                onChange={(e) => setAddPlate(e.target.value.toUpperCase())}
                                onKeyDown={(e) => { if (e.key === 'Enter') addToPool(); }}
                            />
                            <Button
                                variant="contained"
                                disabled={busy || !addPlate.trim() || !addFlat}
                                onClick={addToPool}
                            >
                                Add and assign
                            </Button>
                        </Stack>
                    ) : null}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
