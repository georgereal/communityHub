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
    ListItemButton,
    ListItemText,
    Stack,
    Tab,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import CapGate from '../../components/CapGate.jsx';
import { portalState } from '../../store.js';
import {
    assignPoolSlot,
    listPoolSlots,
    listUnitOptions,
    releasePoolSlot,
    saveVehicle,
    searchPoolCandidates,
} from './api.js';
import { getSlotPoolKind as slotKind } from '../../parkingImport.js';

function liveSlot(slot) {
    if (!slot) return null;
    return (portalState.slots || []).find((s) => s.id === slot.id)
        || listPoolSlots(slotKind(slot) || 'car').find((s) => s.id === slot.id)
        || slot;
}

function findAssigned(slot) {
    if (!slot?.assigned_vehicle_id) return { unit: null, vehicle: null };
    for (const u of portalState.units || []) {
        const vehicle = (u.vehicles || []).find((v) => v.id === slot.assigned_vehicle_id);
        if (vehicle) return { unit: u, vehicle };
    }
    return { unit: null, vehicle: null };
}

function vehicleOnFlat(unitId, plate) {
    const unit = (portalState.units || []).find((u) => u.id === unitId);
    const want = String(plate || '').trim().toUpperCase();
    return (unit?.vehicles || []).find((v) => String(v.plate || '').toUpperCase() === want) || null;
}

export default function PoolSlotDialog({ open, slot: slotProp, onClose, onSaved }) {
    const [rev, setRev] = useState(0);
    const slot = liveSlot(slotProp);
    const kind = slot ? slotKind(slot) || 'car' : 'car';
    const label = kind === 'bike' ? 'BH' : 'EH';
    const type = kind === 'bike' ? 'BIKE' : 'CAR';
    const flats = listUnitOptions();
    const occupied = Boolean(slot?.assigned_vehicle_id || slot?.occupant);
    const assigned = findAssigned(slot);

    const [fillTab, setFillTab] = useState(0);
    const [q, setQ] = useState('');
    const [addPlate, setAddPlate] = useState('');
    const [addFlat, setAddFlat] = useState(null);
    const [editingPlate, setEditingPlate] = useState(false);
    const [plateDraft, setPlateDraft] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setFillTab(0);
        setQ('');
        setAddPlate('');
        setAddFlat(null);
        setEditingPlate(false);
        setError('');
    }, [open, slotProp?.id]);

    const candidates = useMemo(
        () => searchPoolCandidates({ kind, q, overlimitOnly: !q.trim() }),
        [kind, q, open, rev, occupied],
    );

    const bump = () => {
        setRev((n) => n + 1);
        onSaved?.();
    };

    const putOnSlot = async (vehicleId) => {
        setBusy(true);
        setError('');
        try {
            await assignPoolSlot(slot.id, vehicleId);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not assign.');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError('');
        try {
            await releasePoolSlot(slot.id);
            setEditingPlate(false);
            setFillTab(0);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not remove.');
        } finally {
            setBusy(false);
        }
    };

    const savePlate = async () => {
        const next = plateDraft.trim().toUpperCase();
        if (!assigned.vehicle || !assigned.unit || !next) return;
        setBusy(true);
        setError('');
        try {
            await saveVehicle({ unitId: assigned.unit.id, plate: next, type: assigned.vehicle.type || type }, assigned.vehicle);
            setEditingPlate(false);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not update plate.');
        } finally {
            setBusy(false);
        }
    };

    const addNew = async () => {
        const plate = addPlate.trim().toUpperCase();
        if (!plate || !addFlat?.id) {
            setError('Pick a flat and enter the plate.');
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
            bump();
        } catch (err) {
            setError(err?.message || 'Could not add.');
        } finally {
            setBusy(false);
        }
    };

    const plate = slot?.occupant || assigned.vehicle?.plate || '';
    const flatNo = slot?.unit_num || assigned.unit?.number || '';

    return (
        <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                {slot?.name || label}
                <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}

                    {occupied ? (
                        <Stack spacing={1}>
                            <Typography variant="body2" color="text.secondary">
                                This slot is assigned. Edit the plate or remove it; then you can fill the slot.
                            </Typography>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                <span className="parking-vchip parking-vchip--pool">
                                    <span className="parking-vchip__plate">{plate} · {flatNo}</span>
                                </span>
                                <CapGate cap="parking.update">
                                    {editingPlate ? (
                                        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', mt: 0.5 }}>
                                            <TextField
                                                autoFocus
                                                size="small"
                                                label="Vehicle plate"
                                                value={plateDraft}
                                                onChange={(e) => setPlateDraft(e.target.value.toUpperCase())}
                                                onKeyDown={(e) => { if (e.key === 'Enter') savePlate(); }}
                                                sx={{ flex: 1 }}
                                            />
                                            <Button size="small" variant="contained" onClick={savePlate} disabled={busy}>Save</Button>
                                            <Button size="small" onClick={() => setEditingPlate(false)}>Cancel</Button>
                                        </Stack>
                                    ) : (
                                        <>
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    setPlateDraft(plate);
                                                    setEditingPlate(true);
                                                }}
                                            >
                                                Edit plate
                                            </Button>
                                            <CapGate cap="parking.delete">
                                                <Button size="small" color="error" disabled={busy} onClick={remove}>
                                                    Remove
                                                </Button>
                                            </CapGate>
                                        </>
                                    )}
                                </CapGate>
                            </Stack>
                        </Stack>
                    ) : (
                        <CapGate cap="parking.update" fallback={<Typography color="text.secondary">This slot is empty.</Typography>}>
                        <Stack spacing={1}>
                            <Typography variant="body2" color="text.secondary">
                                Slot is empty. Assign an overallocated vehicle or add a new one.
                            </Typography>
                            <Tabs value={fillTab} onChange={(_, v) => setFillTab(v)} variant="fullWidth">
                                <Tab label="Overallocated" />
                                <Tab label="Add new" />
                            </Tabs>
                            {fillTab === 0 ? (
                                <Stack spacing={1} sx={{ pt: 1 }}>
                                    <TextField
                                        size="small"
                                        label="Search plate or flat"
                                        value={q}
                                        onChange={(e) => setQ(e.target.value)}
                                        fullWidth
                                    />
                                    <List dense sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, maxHeight: 240, overflow: 'auto' }}>
                                        {candidates.length === 0 ? (
                                            <Typography sx={{ p: 2 }} color="text.secondary">No overallocated vehicles.</Typography>
                                        ) : candidates.map((v) => (
                                            <ListItemButton key={v.id} disabled={busy} onClick={() => putOnSlot(v.id)}>
                                                <ListItemText
                                                    primary={v.plate}
                                                    secondary={`Flat ${v.unit_number}${v.status === 'OVERLIMIT' ? ' · overallocated' : ''}`}
                                                />
                                            </ListItemButton>
                                        ))}
                                    </List>
                                </Stack>
                            ) : (
                                <Stack spacing={1} sx={{ pt: 1 }}>
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
                                        onKeyDown={(e) => { if (e.key === 'Enter') addNew(); }}
                                    />
                                    <Button
                                        variant="contained"
                                        disabled={busy || !addPlate.trim() || !addFlat}
                                        onClick={addNew}
                                    >
                                        Assign to {slot?.name || label}
                                    </Button>
                                </Stack>
                            )}
                        </Stack>
                        </CapGate>
                    )}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={busy}>Done</Button>
            </DialogActions>
        </Dialog>
    );
}
