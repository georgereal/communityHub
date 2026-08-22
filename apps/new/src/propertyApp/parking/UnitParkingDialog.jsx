import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
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
import CapGate from '../../components/CapGate.jsx';
import { annotateUnitVehicles, saveUnitParkingLimits } from './api.js';
import { TypeEditor } from './InlineUnitEdit.jsx';

export default function UnitParkingDialog({ open, unit, onClose, onSaved }) {
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
                    <CapGate cap="parking.base_slots" mode="disable">
                        <Stack direction="row" spacing={1} alignItems="center">
                            <TextField
                                label="Car slots"
                                type="number"
                                size="small"
                                value={carLimit}
                                onChange={(e) => setCarLimit(e.target.value)}
                                sx={{ width: 120 }}
                                inputProps={{ min: 0 }}
                            />
                            <TextField
                                label="Bike slots"
                                type="number"
                                size="small"
                                value={bikeLimit}
                                onChange={(e) => setBikeLimit(e.target.value)}
                                sx={{ width: 120 }}
                                inputProps={{ min: 0 }}
                            />
                            <Button size="small" onClick={saveSlots} disabled={savingSlots}>Save slots</Button>
                        </Stack>
                    </CapGate>
                    <TypeEditor title="Cars" type="CAR" unit={ann} onSaved={onSaved} setError={setError} />
                    <TypeEditor title="Bikes" type="BIKE" unit={ann} onSaved={onSaved} setError={setError} />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Done</Button>
            </DialogActions>
        </Dialog>
    );
}
