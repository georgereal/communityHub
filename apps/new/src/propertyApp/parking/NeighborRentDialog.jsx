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
    listFlatRentals,
    listUnitOptions,
    saveVehicle,
    searchPoolCandidates,
    setVehicleAllocation,
    vacantHostFlats,
} from './api.js';

function vehicleOnFlat(unitId, plate) {
    const unit = (portalState.units || []).find((u) => u.id === unitId);
    const want = String(plate || '').trim().toUpperCase();
    return (unit?.vehicles || []).find((v) => String(v.plate || '').toUpperCase() === want) || null;
}

function findVehicle(vehicleId) {
    for (const u of portalState.units || []) {
        const v = (u.vehicles || []).find((x) => x.id === vehicleId);
        if (v) return { unit: u, vehicle: v };
    }
    return { unit: null, vehicle: null };
}

export default function NeighborRentDialog({ open, onClose, onSaved }) {
    const flats = listUnitOptions();
    const [rev, setRev] = useState(0);
    const [kindTab, setKindTab] = useState(0);
    const [fillTab, setFillTab] = useState(0);
    const [q, setQ] = useState('');
    const [filterRentals, setFilterRentals] = useState('');
    const [pickedVehicleId, setPickedVehicleId] = useState('');
    const [hostFlat, setHostFlat] = useState(null);
    const [addHome, setAddHome] = useState(null);
    const [addPlate, setAddPlate] = useState('');
    const [addHost, setAddHost] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [plateDraft, setPlateDraft] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const type = kindTab === 1 ? 'BIKE' : 'CAR';
    const kind = kindTab === 1 ? 'bike' : 'car';
    const typeLabel = kindTab === 1 ? 'bikes' : 'cars';

    useEffect(() => {
        if (!open) return;
        setKindTab(0);
        setFillTab(0);
        setQ('');
        setFilterRentals('');
        setPickedVehicleId('');
        setHostFlat(null);
        setAddHome(null);
        setAddPlate('');
        setAddHost(null);
        setEditingId(null);
        setError('');
    }, [open]);

    const rentals = useMemo(() => {
        const query = filterRentals.trim().toLowerCase();
        return listFlatRentals().filter((r) => {
            if (!query) return true;
            const hay = `${r.plate} ${r.sourceLabel} ${r.tenantLabel}`.toLowerCase();
            return hay.includes(query);
        });
    }, [filterRentals, open, rev]);

    const extras = useMemo(
        () => searchPoolCandidates({ kind, q, overlimitOnly: !q.trim() }),
        [kind, q, open, rev],
    );
    const hosts = useMemo(() => vacantHostFlats(type), [type, open, rev]);

    const bump = () => {
        setRev((n) => n + 1);
        onSaved?.();
    };

    const remove = async (vehicleId) => {
        setBusy(true);
        setError('');
        try {
            await setVehicleAllocation(vehicleId, { allocation_type: 'BASE' });
            setEditingId(null);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not remove rental.');
        } finally {
            setBusy(false);
        }
    };

    const savePlate = async (rental) => {
        const next = plateDraft.trim().toUpperCase();
        const found = findVehicle(rental.vehicleId);
        if (!found.vehicle || !found.unit || !next) return;
        setBusy(true);
        setError('');
        try {
            await saveVehicle({
                unitId: found.unit.id,
                plate: next,
                type: found.vehicle.type,
            }, found.vehicle);
            setEditingId(null);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not update plate.');
        } finally {
            setBusy(false);
        }
    };

    const rentExisting = async () => {
        if (!pickedVehicleId || !hostFlat?.id) {
            setError('Pick an overallocated vehicle and a flat with a vacant slot.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            await setVehicleAllocation(pickedVehicleId, {
                allocation_type: 'NEIGHBOR',
                allocation_target_id: hostFlat.id,
            });
            setPickedVehicleId('');
            setHostFlat(null);
            bump();
        } catch (err) {
            setError(err?.message || 'Could not save rental.');
        } finally {
            setBusy(false);
        }
    };

    const rentNew = async () => {
        const plate = addPlate.trim().toUpperCase();
        if (!plate || !addHome?.id || !addHost?.id) {
            setError('Pick the vehicle’s flat, enter the plate, and pick the vacant slot’s flat.');
            return;
        }
        if (addHome.id === addHost.id) {
            setError('Rent from a different flat than the vehicle’s home.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            let vehicle = vehicleOnFlat(addHome.id, plate);
            if (!vehicle) {
                await saveVehicle({ unitId: addHome.id, plate, type });
                vehicle = vehicleOnFlat(addHome.id, plate);
            }
            if (!vehicle?.id) throw new Error('Vehicle was not saved.');
            await setVehicleAllocation(vehicle.id, {
                allocation_type: 'NEIGHBOR',
                allocation_target_id: addHost.id,
            });
            setAddPlate('');
            bump();
        } catch (err) {
            setError(err?.message || 'Could not add rental.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md" scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                Rent from another flat
                <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2.25} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    <Typography variant="body2" color="text.secondary">
                        A vehicle stays on its home flat but uses a vacant base slot on another flat.
                    </Typography>

                    <Stack
                        direction={{ xs: 'column', md: 'row' }}
                        spacing={2.5}
                        alignItems={{ md: 'stretch' }}
                    >
                    <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography fontWeight={700}>Current rentals</Typography>
                        <TextField
                            size="small"
                            label="Filter rentals"
                            value={filterRentals}
                            onChange={(e) => setFilterRentals(e.target.value)}
                            fullWidth
                        />
                        {rentals.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">No rentals yet.</Typography>
                        ) : (
                            <List dense sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, maxHeight: 200, overflow: 'auto' }}>
                                {rentals.map((r) => (
                                    <ListItemButton key={r.vehicleId} sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }} disableRipple>
                                        <ListItemText
                                            primary={`${r.plate} · ${r.tenantLabel} from ${r.sourceLabel}`}
                                            sx={{ pr: 1 }}
                                        />
                                        <CapGate cap="parking.update">
                                            {editingId === r.vehicleId ? (
                                                <Stack direction="row" spacing={0.75} sx={{ width: '100%', mt: 0.5 }}>
                                                    <TextField
                                                        size="small"
                                                        label="Plate"
                                                        value={plateDraft}
                                                        onChange={(e) => setPlateDraft(e.target.value.toUpperCase())}
                                                        sx={{ flex: 1 }}
                                                    />
                                                    <Button size="small" variant="contained" disabled={busy} onClick={() => savePlate(r)}>Save</Button>
                                                    <Button size="small" onClick={() => setEditingId(null)}>Cancel</Button>
                                                </Stack>
                                            ) : (
                                                <Stack direction="row" spacing={0.5}>
                                                    <Button
                                                        size="small"
                                                        onClick={() => {
                                                            setPlateDraft(r.plate);
                                                            setEditingId(r.vehicleId);
                                                        }}
                                                    >
                                                        Edit
                                                    </Button>
                                                    <CapGate cap="parking.delete">
                                                        <Button size="small" color="error" disabled={busy} onClick={() => remove(r.vehicleId)}>
                                                            Remove
                                                        </Button>
                                                    </CapGate>
                                                </Stack>
                                            )}
                                        </CapGate>
                                    </ListItemButton>
                                ))}
                            </List>
                        )}
                    </Stack>

                    <CapGate cap="parking.update">
                        <Stack spacing={1} sx={{ flex: 1.15, minWidth: 0 }}>
                            <Typography fontWeight={700}>Add rentals</Typography>
                            <Tabs value={kindTab} onChange={(_, v) => { setKindTab(v); setFillTab(0); setPickedVehicleId(''); setHostFlat(null); }} variant="fullWidth">
                                <Tab label="Cars" />
                                <Tab label="Bikes" />
                            </Tabs>
                            <Tabs value={fillTab} onChange={(_, v) => setFillTab(v)} variant="fullWidth">
                                <Tab label="Overallocated" />
                                <Tab label="Add new" />
                            </Tabs>

                            {fillTab === 0 ? (
                                <Stack spacing={1} sx={{ pt: 0.5 }}>
                                    <Typography variant="body2" color="text.secondary">
                                        Move an extra {typeLabel.slice(0, -1)} onto a flat that still has a vacant {typeLabel.slice(0, -1)} slot.
                                    </Typography>
                                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
                                        <Stack spacing={1} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                                            <TextField
                                                size="small"
                                                label="Search plate or flat"
                                                value={q}
                                                onChange={(e) => setQ(e.target.value)}
                                                fullWidth
                                            />
                                            <List dense sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, maxHeight: 220, overflow: 'auto' }}>
                                                {extras.length === 0 ? (
                                                    <Typography sx={{ p: 2 }} color="text.secondary">No overallocated {typeLabel}.</Typography>
                                                ) : extras.map((v) => (
                                                    <ListItemButton
                                                        key={v.id}
                                                        selected={v.id === pickedVehicleId}
                                                        disabled={busy}
                                                        onClick={() => setPickedVehicleId(v.id)}
                                                    >
                                                        <ListItemText
                                                            primary={v.plate}
                                                            secondary={`Home ${v.unit_number}${v.status === 'OVERLIMIT' ? ' · overallocated' : ''}`}
                                                        />
                                                    </ListItemButton>
                                                ))}
                                            </List>
                                        </Stack>
                                        <Stack spacing={1} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                                            <Autocomplete
                                                options={hosts.filter((h) => h.id !== extras.find((v) => v.id === pickedVehicleId)?.unit_id)}
                                                getOptionLabel={(o) => `${o.number} · ${o.free} free`}
                                                value={hostFlat}
                                                onChange={(_, v) => setHostFlat(v)}
                                                renderInput={(params) => <TextField {...params} size="small" label="Vacant slot on" />}
                                            />
                                            <Button
                                                variant="contained"
                                                disabled={busy || !pickedVehicleId || !hostFlat}
                                                onClick={rentExisting}
                                            >
                                                Rent {typeLabel.slice(0, -1)} slot
                                            </Button>
                                        </Stack>
                                    </Stack>
                                </Stack>
                            ) : (
                                <Stack spacing={1} sx={{ pt: 0.5 }}>
                                    <Typography variant="body2" color="text.secondary">
                                        Register a {typeLabel.slice(0, -1)} on its home flat and rent a vacant slot from another flat.
                                    </Typography>
                                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
                                        <Stack spacing={1} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                                            <Autocomplete
                                                options={flats}
                                                getOptionLabel={(o) => o.number || ''}
                                                value={addHome}
                                                onChange={(_, v) => setAddHome(v)}
                                                renderInput={(params) => <TextField {...params} size="small" label="Vehicle’s flat" />}
                                            />
                                            <TextField
                                                size="small"
                                                label="Vehicle plate"
                                                value={addPlate}
                                                onChange={(e) => setAddPlate(e.target.value.toUpperCase())}
                                            />
                                        </Stack>
                                        <Stack spacing={1} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                                            <Autocomplete
                                                options={hosts.filter((h) => h.id !== addHome?.id)}
                                                getOptionLabel={(o) => `${o.number} · ${o.free} free`}
                                                value={addHost}
                                                onChange={(_, v) => setAddHost(v)}
                                                renderInput={(params) => <TextField {...params} size="small" label="Vacant slot on" />}
                                            />
                                            <Button
                                                variant="contained"
                                                disabled={busy || !addHome || !addPlate.trim() || !addHost}
                                                onClick={rentNew}
                                            >
                                                Add and rent
                                            </Button>
                                        </Stack>
                                    </Stack>
                                </Stack>
                            )}
                        </Stack>
                    </CapGate>
                    </Stack>
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={busy}>Done</Button>
            </DialogActions>
        </Dialog>
    );
}
