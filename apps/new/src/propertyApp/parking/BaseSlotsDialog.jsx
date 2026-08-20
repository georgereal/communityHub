import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Stack,
    Tab,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { canEditBaseSlots, listParkingUnits, saveUnitParkingLimits, saveUnitParkingLimitsBulk } from './api.js';

export default function BaseSlotsDialog({ open, onClose, onSaved }) {
    const canEdit = canEditBaseSlots();
    const [tab, setTab] = useState(0);
    const [q, setQ] = useState('');
    const [unitId, setUnitId] = useState('');
    const [carLimit, setCarLimit] = useState(0);
    const [bikeLimit, setBikeLimit] = useState(0);
    const [bulkCar, setBulkCar] = useState('');
    const [bulkBike, setBulkBike] = useState('');
    const [picked, setPicked] = useState(() => new Set());
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const flats = useMemo(() => {
        const query = q.trim().toLowerCase();
        return listParkingUnits({ search: query, filter: 'all' });
    }, [q, open]);

    const selected = flats.find((u) => u.id === unitId) || null;
    const allIds = flats.map((u) => u.id);
    const allPicked = allIds.length > 0 && allIds.every((id) => picked.has(id));

    useEffect(() => {
        if (open) {
            setTab(0);
            setQ('');
            setUnitId('');
            setPicked(new Set());
            setBulkCar('');
            setBulkBike('');
            setError('');
        }
    }, [open]);

    useEffect(() => {
        if (!selected) return;
        setCarLimit(selected.car_limit ?? 0);
        setBikeLimit(selected.bike_limit ?? 0);
    }, [selected?.id, selected?.car_limit, selected?.bike_limit]);

    const toggle = (id) => {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        setPicked(allPicked ? new Set() : new Set(allIds));
    };

    const saveOne = async () => {
        if (!unitId) {
            setError('Pick a flat.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            await saveUnitParkingLimits(unitId, {
                car_limit: Number(carLimit) || 0,
                bike_limit: Number(bikeLimit) || 0,
            });
            onSaved?.();
        } catch (err) {
            setError(err?.message || 'Could not save base slots.');
        } finally {
            setBusy(false);
        }
    };

    const saveBulk = async () => {
        const ids = allIds.filter((id) => picked.has(id));
        if (!ids.length) {
            setError('Select one or more flats.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const patch = {};
            if (String(bulkCar).trim() !== '') patch.car_limit = Number(bulkCar);
            if (String(bulkBike).trim() !== '') patch.bike_limit = Number(bulkBike);
            const out = await saveUnitParkingLimitsBulk(ids, patch);
            setPicked(new Set());
            onSaved?.();
            setError('');
            return out;
        } catch (err) {
            setError(err?.message || 'Could not update flats.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                Base parking slots
                <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Typography variant="body2" color="text.secondary">
                        Each flat’s included car and bike slots. Raising a limit moves extra vehicles out of overallocated automatically.
                    </Typography>
                    {canEdit ? (
                        <Tabs value={tab} onChange={(_, v) => { setTab(v); setError(''); }} variant="fullWidth">
                            <Tab label="One flat" />
                            <Tab label="Bulk update" />
                        </Tabs>
                    ) : null}
                    <TextField
                        size="small"
                        label="Search flat"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        fullWidth
                    />
                    {tab === 1 && canEdit ? (
                        <Stack direction="row" alignItems="center">
                            <Checkbox checked={allPicked} indeterminate={picked.size > 0 && !allPicked} onChange={toggleAll} />
                            <Typography variant="body2">Select all {flats.length} listed</Typography>
                        </Stack>
                    ) : null}
                    <Stack sx={{ maxHeight: 240, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                        {flats.length === 0 ? (
                            <Typography sx={{ p: 2 }} color="text.secondary">No matching flats.</Typography>
                        ) : tab === 1 && canEdit ? (
                            <List dense>
                                {flats.map((u) => (
                                    <ListItem key={u.id} disablePadding>
                                        <ListItemButton onClick={() => toggle(u.id)}>
                                            <ListItemIcon sx={{ minWidth: 36 }}>
                                                <Checkbox edge="start" checked={picked.has(u.id)} tabIndex={-1} disableRipple />
                                            </ListItemIcon>
                                            <ListItemText
                                                primary={u.number}
                                                secondary={`${u.car_limit || 0} car · ${u.bike_limit || 0} bike`}
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                ))}
                            </List>
                        ) : (
                            <List dense>
                                {flats.map((u) => (
                                    <ListItemButton
                                        key={u.id}
                                        selected={u.id === unitId}
                                        onClick={() => setUnitId(u.id)}
                                    >
                                        <ListItemText
                                            primary={u.number}
                                            secondary={`${u.car_limit || 0} car · ${u.bike_limit || 0} bike`}
                                        />
                                    </ListItemButton>
                                ))}
                            </List>
                        )}
                    </Stack>
                    {canEdit && tab === 0 && selected ? (
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                            <TextField
                                size="small"
                                type="number"
                                label="Car slots"
                                value={carLimit}
                                onChange={(e) => setCarLimit(e.target.value)}
                                sx={{ width: 120 }}
                                inputProps={{ min: 0 }}
                            />
                            <TextField
                                size="small"
                                type="number"
                                label="Bike slots"
                                value={bikeLimit}
                                onChange={(e) => setBikeLimit(e.target.value)}
                                sx={{ width: 120 }}
                                inputProps={{ min: 0 }}
                            />
                            <Button variant="contained" onClick={saveOne} disabled={busy}>
                                Save slots
                            </Button>
                        </Stack>
                    ) : null}
                    {canEdit && tab === 1 ? (
                        <Stack spacing={1}>
                            <Typography variant="body2" color="text.secondary">
                                Fill only the counts you want to change. Leave a field blank to keep each flat’s current value.
                                {picked.size ? ` ${picked.size} selected.` : ''}
                            </Typography>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                <TextField
                                    size="small"
                                    type="number"
                                    label="Car slots"
                                    placeholder="Keep"
                                    value={bulkCar}
                                    onChange={(e) => setBulkCar(e.target.value)}
                                    sx={{ width: 130 }}
                                    inputProps={{ min: 0 }}
                                />
                                <TextField
                                    size="small"
                                    type="number"
                                    label="Bike slots"
                                    placeholder="Keep"
                                    value={bulkBike}
                                    onChange={(e) => setBulkBike(e.target.value)}
                                    sx={{ width: 130 }}
                                    inputProps={{ min: 0 }}
                                />
                                <Button
                                    variant="contained"
                                    onClick={saveBulk}
                                    disabled={busy || picked.size === 0 || (String(bulkCar).trim() === '' && String(bulkBike).trim() === '')}
                                >
                                    Update selected
                                </Button>
                            </Stack>
                        </Stack>
                    ) : null}
                    {!canEdit ? (
                        <Alert severity="info">Only apartment admins can change base slot counts.</Alert>
                    ) : null}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
