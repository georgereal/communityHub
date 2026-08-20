import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import {
    annotateUnitVehicles,
    canEditParking,
    removeVehicle,
    saveUnitParkingLimits,
    saveVehicle,
    vehiclesOfType,
} from './api.js';
import { effectiveAllocationType } from '../../allocation.js';

function Tag({ vehicle, onEdit, onRemove, canEdit }) {
    const alloc = effectiveAllocationType(vehicle);
    const tone = vehicle.status === 'OVERLIMIT'
        ? 'overlimit'
        : alloc === 'COMMON'
            ? 'pool'
            : vehicle.status === 'INACTIVE'
                ? 'dormant'
                : 'base';
    const [editing, setEditing] = useState(false);
    const [plate, setPlate] = useState(vehicle.plate || '');

    useEffect(() => {
        setPlate(vehicle.plate || '');
        setEditing(false);
    }, [vehicle.plate, vehicle.id]);

    if (editing && canEdit) {
        return (
            <TextField
                autoFocus
                size="small"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                onBlur={() => {
                    setEditing(false);
                    const next = plate.trim().toUpperCase();
                    if (next && next !== vehicle.plate) onEdit(next);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                        setPlate(vehicle.plate || '');
                        setEditing(false);
                    }
                }}
                sx={{ width: 130 }}
            />
        );
    }

    return (
        <span className={`parking-vchip parking-vchip--${tone}`}>
            <button type="button" className="parking-vchip__plate" onClick={() => canEdit && setEditing(true)}>
                {vehicle.plate}
            </button>
            {canEdit ? (
                <button type="button" className="parking-vchip__x" title="Remove" onClick={() => onRemove()}>×</button>
            ) : null}
        </span>
    );
}

function TypeEditor({ title, type, unit, canEdit, onSaved, setError }) {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const vehicles = vehiclesOfType(annotateUnitVehicles(unit), type);

    const add = async () => {
        const plate = draft.trim().toUpperCase();
        if (!plate) return;
        setBusy(true);
        setError('');
        try {
            await saveVehicle({ unitId: unit.id, plate, type });
            setDraft('');
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not add.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Box>
            <Typography fontWeight={700} sx={{ mb: 0.75 }}>{title}</Typography>
            <Stack direction="row" flexWrap="wrap" gap={0.75} alignItems="center">
                {vehicles.map((v) => (
                    <Tag
                        key={v.id}
                        vehicle={v}
                        canEdit={canEdit}
                        onEdit={async (plate) => {
                            setError('');
                            try {
                                await saveVehicle({ unitId: unit.id, plate, type: v.type }, v);
                                onSaved?.();
                            } catch (err) {
                                setError(err?.message || 'Could not update.');
                            }
                        }}
                        onRemove={async () => {
                            if (!window.confirm(`Remove ${v.plate}?`)) return;
                            setError('');
                            try {
                                await removeVehicle(unit.id, v.id);
                                onSaved?.();
                            } catch (err) {
                                setError(err?.message || 'Could not remove.');
                            }
                        }}
                    />
                ))}
                {canEdit ? (
                    <TextField
                        size="small"
                        placeholder="Add plate"
                        value={draft}
                        disabled={busy}
                        onChange={(e) => setDraft(e.target.value.toUpperCase())}
                        onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                        sx={{ width: 140 }}
                    />
                ) : null}
                {canEdit ? (
                    <Button size="small" onClick={add} disabled={busy || !draft.trim()}>Add</Button>
                ) : null}
            </Stack>
        </Box>
    );
}

export default function UnitParkingDialog({ open, unit, onClose, onSaved }) {
    const canEdit = canEditParking();
    const [carLimit, setCarLimit] = useState(0);
    const [bikeLimit, setBikeLimit] = useState(0);
    const [error, setError] = useState('');
    const [savingSlots, setSavingSlots] = useState(false);

    useEffect(() => {
        if (!open || !unit) return;
        setCarLimit(unit.car_limit ?? 0);
        setBikeLimit(unit.bike_limit ?? 0);
        setError('');
    }, [open, unit]);

    const ann = useMemo(() => (unit ? annotateUnitVehicles(unit) : null), [unit]);
    if (!unit || !ann) return null;

    const saveSlots = async () => {
        setSavingSlots(true);
        setError('');
        try {
            await saveUnitParkingLimits(unit.id, {
                car_limit: Number(carLimit) || 0,
                bike_limit: Number(bikeLimit) || 0,
            });
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not save slots.');
        } finally {
            setSavingSlots(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                Edit vehicles — {unit.number}
                <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2.5} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Typography variant="body2" color="text.secondary">
                        Vehicles over this flat’s car/bike slots show as overallocated (red). Raise slots or move extras to EH/BH or another flat.
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                        <TextField
                            label="Car slots"
                            type="number"
                            size="small"
                            value={carLimit}
                            onChange={(e) => setCarLimit(e.target.value)}
                            disabled={!canEdit}
                            sx={{ width: 120 }}
                            inputProps={{ min: 0 }}
                        />
                        <TextField
                            label="Bike slots"
                            type="number"
                            size="small"
                            value={bikeLimit}
                            onChange={(e) => setBikeLimit(e.target.value)}
                            disabled={!canEdit}
                            sx={{ width: 120 }}
                            inputProps={{ min: 0 }}
                        />
                        {canEdit ? (
                            <Button size="small" onClick={saveSlots} disabled={savingSlots}>Save slots</Button>
                        ) : null}
                    </Stack>
                    <TypeEditor title="Cars" type="CAR" unit={ann} canEdit={canEdit} onSaved={onSaved} setError={setError} />
                    <TypeEditor title="Bikes" type="BIKE" unit={ann} canEdit={canEdit} onSaved={onSaved} setError={setError} />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Done</Button>
            </DialogActions>
        </Dialog>
    );
}
