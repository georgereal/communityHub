import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    Stack,
    Tab,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import {
    Add as AddIcon,
    Check as CheckIcon,
    Close as CloseIcon,
    Delete as DeleteIcon,
    Edit as EditIcon,
    ExpandLess as ExpandLessIcon,
    ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import CapGate from '../../components/CapGate.jsx';
import { can } from '../../capabilities.js';
import { deleteResident, saveResident } from '../../residentsApp/api.js';
import {
    annotateUnitVehicles,
    listIncomingRentals,
    removeVehicle,
    saveVehicle,
} from '../parking/api.js';
import { effectiveAllocationType } from '../../allocation.js';
import {
    OCCUPANCY_STATUS_VALUES,
    listDirectoryUnits,
    loadUnitFinance,
    occupancyLabel,
    saveUnitFields,
} from './api.js';

const fieldSx = {
    '& .MuiInputBase-root': { bgcolor: '#fff', fontSize: '0.82rem' },
    '& .MuiInputLabel-root': { fontSize: '0.78rem' },
};

function inr(n) {
    return `₹${Number(n || 0).toLocaleString('en-IN')}`;
}

function monthYy(iso) {
    const s = String(iso || '').slice(0, 10);
    const d = new Date(`${s}T12:00:00`);
    if (!s || Number.isNaN(d.getTime())) return iso || '—';
    const mon = d.toLocaleString('en-GB', { month: 'short' });
    const yy = String(d.getFullYear()).slice(-2);
    return `${mon}-${yy}`;
}

const PREFERRED_HEADS = [
    'Maintenance charges',
    'Common water consumption charges',
    'Water Meter Rent',
    'Car Parking',
    'Home water consumption charges',
    'Non Occupancy Charges',
];

function parseMoney(val) {
    if (val == null || val === '') return 0;
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    const n = parseFloat(String(val).replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function chargeMap(row) {
    return row?.charges && typeof row.charges === 'object' && !Array.isArray(row.charges)
        ? row.charges
        : {};
}

function chargeTotal(row) {
    const raised = parseMoney(row?.total_raised);
    if (raised) return raised;
    return Object.values(chargeMap(row)).reduce((s, v) => s + parseMoney(v), 0);
}

function shortHead(label) {
    return String(label || '').replace(/\s*charges?\s*$/i, '').trim() || label;
}

function chargeHeadsForRows(rows) {
    const amounts = new Map();
    (rows || []).forEach((r) => {
        Object.entries(chargeMap(r)).forEach(([k, v]) => {
            amounts.set(k, (amounts.get(k) || 0) + Math.abs(parseMoney(v)));
        });
    });
    const present = [...amounts.keys()].filter((h) => (amounts.get(h) || 0) > 0.001);
    const rest = present.filter((h) => !PREFERRED_HEADS.includes(h)).sort((a, b) => a.localeCompare(b));
    return [...PREFERRED_HEADS.filter((h) => present.includes(h)), ...rest];
}

function emptyPerson(kind, unitNumber) {
    return {
        id: null,
        unit_number: unitNumber,
        kind,
        full_name: '',
        phone: '',
        email: '',
        is_primary: false,
        is_residing: kind !== 'TENANT',
    };
}

function PersonEditor({ draft, onChange, onSave, onCancel, busy }) {
    const set = (k, v) => onChange({ ...draft, [k]: v });
    return (
        <TableRow sx={{ bgcolor: '#ecfdf5' }}>
            <TableCell colSpan={5} sx={{ py: 0.6 }}>
                <Box className="unit-detail-grid" sx={{ gridTemplateColumns: '1.4fr 1fr 1.3fr auto', alignItems: 'center' }}>
                    <TextField size="small" label="Name" value={draft.full_name} onChange={(e) => set('full_name', e.target.value)} sx={fieldSx} />
                    <TextField size="small" label="Phone" value={draft.phone || ''} onChange={(e) => set('phone', e.target.value)} sx={fieldSx} />
                    <TextField size="small" label="Email" value={draft.email || ''} onChange={(e) => set('email', e.target.value)} sx={fieldSx} />
                    <Stack direction="row" spacing={0} sx={{ alignItems: 'center' }}>
                        <Checkbox size="small" checked={!!draft.is_primary} onChange={(e) => set('is_primary', e.target.checked)} />
                        <Typography variant="caption">Primary</Typography>
                        {draft.kind !== 'TENANT' ? (
                            <>
                                <Checkbox size="small" checked={draft.is_residing !== false} onChange={(e) => set('is_residing', e.target.checked)} />
                                <Typography variant="caption">Residing</Typography>
                            </>
                        ) : null}
                        <IconButton size="small" color="primary" disabled={busy || !draft.full_name.trim()} onClick={onSave}>
                            {busy ? <CircularProgress size={14} /> : <CheckIcon fontSize="small" />}
                        </IconButton>
                        <IconButton size="small" onClick={onCancel}><CloseIcon fontSize="small" /></IconButton>
                    </Stack>
                </Box>
            </TableCell>
        </TableRow>
    );
}

export default function UnitDetailDialog({
    open,
    unit,
    mode = 'view',
    onClose,
    onSaved,
    onModeChange,
}) {
    const canEditMaster = can('units.update');
    const canEditCars = can('parking.update');
    const editing = mode === 'edit' && canEditMaster;
    const [tab, setTab] = useState('overview');
    const [form, setForm] = useState({});
    const [saving, setSaving] = useState(false);
    const [rowBusy, setRowBusy] = useState(false);
    const [error, setError] = useState('');
    const [finance, setFinance] = useState({ invoices: [], payments: [], nobroker: [], unavailable: false });
    const [financeLoading, setFinanceLoading] = useState(false);
    const [personDraft, setPersonDraft] = useState(null);
    const [vehicleDraft, setVehicleDraft] = useState(null);
    const [tick, setTick] = useState(0);
    const [nbSplitOpen, setNbSplitOpen] = useState(false);

    const live = useMemo(() => {
        if (!unit?.id) return unit;
        return listDirectoryUnits({ search: '', occupancy: '' }).find((u) => u.id === unit.id) || unit;
    }, [unit, open, tick]);

    useEffect(() => {
        if (!open) return;
        setTab('overview');
        setPersonDraft(null);
        setVehicleDraft(null);
    }, [open, unit?.id]);

    useEffect(() => {
        if (!open || !live) return;
        setError('');
        setForm({
            block: live?.block || '',
            bhk: live?.bhk || '',
            area_sqft: live?.area_sqft ?? '',
            car_limit: live?.car_limit ?? 0,
            bike_limit: live?.bike_limit ?? 0,
            occupancy_status: live?.occupancy_status || '',
            notes: live?.notes || '',
        });
    }, [open, live, mode]);

    useEffect(() => {
        if (!open || !live) return;
        let cancelled = false;
        setFinanceLoading(true);
        loadUnitFinance(live).then((data) => {
            if (!cancelled) setFinance(data);
        }).finally(() => {
            if (!cancelled) setFinanceLoading(false);
        });
        return () => { cancelled = true; };
    }, [open, live?.id]);

    const annotated = useMemo(
        () => (live ? annotateUnitVehicles(live) : null),
        [live],
    );
    const incoming = useMemo(
        () => (live?.id ? listIncomingRentals(live.id) : []),
        [live],
    );

    const setField = (k, v) => setForm((p) => ({ ...p, [k]: v }));
    const refresh = () => {
        setTick((n) => n + 1);
        onSaved?.();
    };

    const handleSaveMaster = async () => {
        if (!live?.id) return;
        setSaving(true);
        setError('');
        try {
            await saveUnitFields(live.id, {
                block: form.block || null,
                bhk: form.bhk || null,
                area_sqft: form.area_sqft === '' ? null : Number(form.area_sqft),
                car_limit: Number(form.car_limit) || 0,
                bike_limit: Number(form.bike_limit) || 0,
                occupancy_status: form.occupancy_status || null,
                notes: form.notes || null,
            });
            refresh();
        } catch (err) {
            setError(err?.message || 'Save failed.');
        } finally {
            setSaving(false);
        }
    };

    const savePersonRow = async () => {
        if (!personDraft?.full_name?.trim()) return;
        setRowBusy(true);
        setError('');
        try {
            await saveResident({
                unit_number: live.number,
                kind: personDraft.kind,
                full_name: personDraft.full_name.trim(),
                phone: personDraft.phone || '',
                email: personDraft.email || '',
                is_primary: !!personDraft.is_primary,
                is_residing: personDraft.kind === 'TENANT' ? true : personDraft.is_residing !== false,
            }, personDraft.id || null);
            setPersonDraft(null);
            refresh();
        } catch (err) {
            setError(err?.message || 'Could not save person.');
        } finally {
            setRowBusy(false);
        }
    };

    const saveVehicleRow = async () => {
        const plate = String(vehicleDraft?.plate || '').trim().toUpperCase();
        if (!plate) return;
        setRowBusy(true);
        setError('');
        try {
            await saveVehicle({
                unitId: live.id,
                plate,
                type: vehicleDraft.type || 'CAR',
            }, vehicleDraft.id ? vehicleDraft : null);
            setVehicleDraft(null);
            refresh();
        } catch (err) {
            setError(err?.message || 'Could not save vehicle.');
        } finally {
            setRowBusy(false);
        }
    };

    const peopleCount = (live?.owners?.length || 0) + (live?.tenants?.length || 0);
    const vehicleCount = (annotated?.vehicles?.length || 0) + incoming.length;
    const tabSx = { textTransform: 'none', minHeight: 34, py: 0, fontSize: '0.8rem', fontWeight: 600 };

    const renderPeople = (title, kind, people) => (
        <Box sx={{ mb: 1.25 }}>
            <Stack direction="row" sx={{ mb: 0.4, alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="subtitle2" fontWeight={700}>{title}</Typography>
                {editing ? (
                    <Button size="small" startIcon={<AddIcon />} onClick={() => setPersonDraft(emptyPerson(kind, live.number))}>
                        Add
                    </Button>
                ) : null}
            </Stack>
            <Table size="small" sx={{ bgcolor: '#fff', borderRadius: 1 }}>
                <TableHead>
                    <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>Phone</TableCell>
                        <TableCell>Email</TableCell>
                        <TableCell>Flags</TableCell>
                        {editing ? <TableCell align="right" /> : null}
                    </TableRow>
                </TableHead>
                <TableBody>
                    {people.length === 0 && !(personDraft && personDraft.kind === kind && !personDraft.id) ? (
                        <TableRow>
                            <TableCell colSpan={editing ? 5 : 4}>
                                <Typography variant="caption" color="text.secondary">None</Typography>
                            </TableCell>
                        </TableRow>
                    ) : people.map((r) => (
                        personDraft?.id === r.id ? (
                            <PersonEditor
                                key={r.id}
                                draft={personDraft}
                                onChange={setPersonDraft}
                                onSave={savePersonRow}
                                onCancel={() => setPersonDraft(null)}
                                busy={rowBusy}
                            />
                        ) : (
                            <TableRow key={r.id} hover={editing} onClick={() => editing && setPersonDraft({ ...r })}>
                                <TableCell>{r.full_name || '—'}</TableCell>
                                <TableCell>{r.phone || '—'}</TableCell>
                                <TableCell>{r.email || '—'}</TableCell>
                                <TableCell>
                                    {r.is_primary ? <Chip size="small" label="Primary" color="success" variant="outlined" /> : null}
                                    {r.is_residing === false ? <Chip size="small" label="Non-residing" sx={{ ml: 0.4 }} /> : null}
                                </TableCell>
                                {editing ? (
                                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                        <IconButton size="small" onClick={() => setPersonDraft({ ...r })}><EditIcon fontSize="small" /></IconButton>
                                        <IconButton
                                            size="small"
                                            onClick={async () => {
                                                if (!window.confirm(`Delete ${r.full_name}?`)) return;
                                                await deleteResident(r.id);
                                                refresh();
                                            }}
                                        >
                                            <DeleteIcon fontSize="small" />
                                        </IconButton>
                                    </TableCell>
                                ) : null}
                            </TableRow>
                        )
                    ))}
                    {personDraft && personDraft.kind === kind && !personDraft.id ? (
                        <PersonEditor
                            draft={personDraft}
                            onChange={setPersonDraft}
                            onSave={savePersonRow}
                            onCancel={() => setPersonDraft(null)}
                            busy={rowBusy}
                        />
                    ) : null}
                </TableBody>
            </Table>
        </Box>
    );

    return (
        <Dialog
            open={open}
            onClose={saving ? undefined : onClose}
            fullWidth
            maxWidth="md"
            scroll="paper"
            className="unit-detail-dialog"
            slotProps={{ paper: { sx: { maxHeight: '90vh', border: '1px solid #99f6e4' } } }}
        >
            <DialogTitle>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                        <Typography component="span" fontWeight={700} noWrap sx={{ color: '#fff' }}>
                            {live?.number || 'Flat'}
                        </Typography>
                        {live?.occupancy ? (
                            <Chip
                                size="small"
                                label={occupancyLabel(live.occupancy)}
                                sx={{ bgcolor: 'rgba(255,255,255,0.16)', color: '#fff', borderColor: 'rgba(255,255,255,0.35)' }}
                                variant="outlined"
                            />
                        ) : null}
                        {editing ? (
                            <Chip size="small" label="Editing" sx={{ bgcolor: '#ccfbf1', color: '#115e59' }} />
                        ) : null}
                    </Stack>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        <CapGate cap="units.update">
                            {!editing ? (
                                <Button size="small" variant="contained" sx={{ bgcolor: '#fff', color: '#0f766e', '&:hover': { bgcolor: '#ecfdf5' } }} startIcon={<EditIcon />} onClick={() => onModeChange?.('edit')}>
                                    Edit
                                </Button>
                            ) : null}
                        </CapGate>
                        {editing ? (
                            <Button size="small" variant="contained" sx={{ bgcolor: '#fff', color: '#0f766e' }} onClick={handleSaveMaster} disabled={saving}>
                                {saving ? <CircularProgress size={14} /> : 'Save'}
                            </Button>
                        ) : null}
                        <IconButton size="small" onClick={onClose} sx={{ color: '#fff' }} aria-label="Close"><CloseIcon /></IconButton>
                    </Stack>
                </Stack>
            </DialogTitle>
            <DialogContent>
                {error ? <Alert severity="error" sx={{ mb: 1, py: 0 }}>{error}</Alert> : null}
                <Tabs
                    value={tab}
                    onChange={(_, v) => setTab(v)}
                    variant="scrollable"
                    allowScrollButtonsMobile
                    sx={{ mb: 1, minHeight: 34, bgcolor: '#fff', borderRadius: 1, '& .MuiTabs-indicator': { backgroundColor: '#0f766e' } }}
                >
                    <Tab value="overview" label="Overview" sx={tabSx} />
                    <Tab value="people" label={`People (${peopleCount})`} sx={tabSx} />
                    <Tab value="vehicles" label={`Vehicles (${vehicleCount})`} sx={tabSx} />
                    <Tab value="finance" label="Invoices" sx={tabSx} />
                </Tabs>

                {tab === 'overview' ? (
                    <Box className="unit-detail-grid">
                        <TextField size="small" label="Flat" value={live?.number || ''} disabled sx={fieldSx} />
                        <TextField size="small" label="Block" value={form.block} disabled={!editing} onChange={(e) => setField('block', e.target.value)} sx={fieldSx} />
                        <TextField size="small" label="BHK / type" value={form.bhk} disabled={!editing} onChange={(e) => setField('bhk', e.target.value)} sx={fieldSx} />
                        <TextField size="small" label="Area (sq ft)" value={form.area_sqft} disabled={!editing} onChange={(e) => setField('area_sqft', e.target.value)} sx={fieldSx} />
                        <TextField size="small" label="Car slots" type="number" value={form.car_limit} disabled={!editing} onChange={(e) => setField('car_limit', e.target.value)} sx={fieldSx} />
                        <TextField size="small" label="Bike slots" type="number" value={form.bike_limit} disabled={!editing} onChange={(e) => setField('bike_limit', e.target.value)} sx={fieldSx} />
                        <FormControl size="small" fullWidth sx={{ gridColumn: '1 / -1', ...fieldSx }}>
                            <InputLabel>Occupancy override</InputLabel>
                            <Select
                                label="Occupancy override"
                                value={form.occupancy_status || ''}
                                disabled={!editing}
                                onChange={(e) => setField('occupancy_status', e.target.value)}
                            >
                                <MenuItem value="">Derived from residents</MenuItem>
                                {OCCUPANCY_STATUS_VALUES.map((k) => (
                                    <MenuItem key={k} value={k}>{occupancyLabel(k)}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            size="small"
                            label="Notes"
                            multiline
                            minRows={2}
                            value={form.notes}
                            disabled={!editing}
                            onChange={(e) => setField('notes', e.target.value)}
                            sx={{ gridColumn: '1 / -1', ...fieldSx }}
                        />
                    </Box>
                ) : null}

                {tab === 'people' ? (
                    <>
                        {renderPeople('Owners', 'OWNER', live?.owners || [])}
                        {renderPeople('Tenants', 'TENANT', live?.tenants || [])}
                        {editing ? (
                            <Typography variant="caption" color="text.secondary">Click a row to edit it here. Check saves the row.</Typography>
                        ) : null}
                    </>
                ) : null}

                {tab === 'vehicles' ? (
                    <Box>
                        <Stack direction="row" sx={{ mb: 0.4, alignItems: 'center', justifyContent: 'space-between' }}>
                            <Typography variant="subtitle2" fontWeight={700}>On this flat</Typography>
                            {editing ? (
                                <CapGate cap="parking.update">
                                    <Button size="small" startIcon={<AddIcon />} onClick={() => setVehicleDraft({ id: null, plate: '', type: 'CAR' })}>
                                        Add
                                    </Button>
                                </CapGate>
                            ) : null}
                        </Stack>
                        <Table size="small" sx={{ bgcolor: '#fff', mb: 1 }}>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Plate</TableCell>
                                    <TableCell>Type</TableCell>
                                    <TableCell>Allocation</TableCell>
                                    <TableCell>Status</TableCell>
                                    {editing && canEditCars ? <TableCell align="right" /> : null}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {(annotated?.vehicles || []).map((v) => (
                                    vehicleDraft?.id === v.id ? (
                                        <TableRow key={v.id} sx={{ bgcolor: '#ecfdf5' }}>
                                            <TableCell>
                                                <TextField size="small" value={vehicleDraft.plate} onChange={(e) => setVehicleDraft({ ...vehicleDraft, plate: e.target.value.toUpperCase() })} sx={fieldSx} />
                                            </TableCell>
                                            <TableCell>
                                                <Select size="small" value={vehicleDraft.type} onChange={(e) => setVehicleDraft({ ...vehicleDraft, type: e.target.value })}>
                                                    <MenuItem value="CAR">Car</MenuItem>
                                                    <MenuItem value="BIKE">Bike</MenuItem>
                                                </Select>
                                            </TableCell>
                                            <TableCell colSpan={2} />
                                            <TableCell align="right">
                                                <IconButton size="small" color="primary" onClick={saveVehicleRow} disabled={rowBusy}><CheckIcon fontSize="small" /></IconButton>
                                                <IconButton size="small" onClick={() => setVehicleDraft(null)}><CloseIcon fontSize="small" /></IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        <TableRow key={v.id} hover={editing} onClick={() => editing && canEditCars && setVehicleDraft({ ...v, type: String(v.type || 'CAR').toUpperCase() })}>
                                            <TableCell>{v.plate}</TableCell>
                                            <TableCell>{String(v.type || 'CAR').toUpperCase()}</TableCell>
                                            <TableCell>{effectiveAllocationType(v)}</TableCell>
                                            <TableCell>{v.status || (v.is_parking_active === false ? 'Inactive' : 'Active')}</TableCell>
                                            {editing && canEditCars ? (
                                                <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                                    <IconButton size="small" onClick={() => setVehicleDraft({ ...v, type: String(v.type || 'CAR').toUpperCase() })}><EditIcon fontSize="small" /></IconButton>
                                                    <IconButton
                                                        size="small"
                                                        onClick={async () => {
                                                            if (!window.confirm(`Remove ${v.plate}?`)) return;
                                                            await removeVehicle(live.id, v.id);
                                                            refresh();
                                                        }}
                                                    >
                                                        <DeleteIcon fontSize="small" />
                                                    </IconButton>
                                                </TableCell>
                                            ) : null}
                                        </TableRow>
                                    )
                                ))}
                                {vehicleDraft && !vehicleDraft.id ? (
                                    <TableRow sx={{ bgcolor: '#ecfdf5' }}>
                                        <TableCell>
                                            <TextField size="small" placeholder="Plate" value={vehicleDraft.plate} onChange={(e) => setVehicleDraft({ ...vehicleDraft, plate: e.target.value.toUpperCase() })} sx={fieldSx} />
                                        </TableCell>
                                        <TableCell>
                                            <Select size="small" value={vehicleDraft.type} onChange={(e) => setVehicleDraft({ ...vehicleDraft, type: e.target.value })}>
                                                <MenuItem value="CAR">Car</MenuItem>
                                                <MenuItem value="BIKE">Bike</MenuItem>
                                            </Select>
                                        </TableCell>
                                        <TableCell colSpan={2} />
                                        <TableCell align="right">
                                            <IconButton size="small" color="primary" onClick={saveVehicleRow} disabled={rowBusy}><CheckIcon fontSize="small" /></IconButton>
                                            <IconButton size="small" onClick={() => setVehicleDraft(null)}><CloseIcon fontSize="small" /></IconButton>
                                        </TableCell>
                                    </TableRow>
                                ) : null}
                                {(annotated?.vehicles || []).length === 0 && !(vehicleDraft && !vehicleDraft.id) ? (
                                    <TableRow>
                                        <TableCell colSpan={5}><Typography variant="caption" color="text.secondary">No vehicles</Typography></TableCell>
                                    </TableRow>
                                ) : null}
                            </TableBody>
                        </Table>
                        {incoming.length ? (
                            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>Renting this slot:</Typography>
                                {incoming.map((v) => (
                                    <Chip key={v.id} size="small" label={`${v.plate} · ${String(v.type || 'CAR').toUpperCase()}`} />
                                ))}
                            </Stack>
                        ) : null}
                    </Box>
                ) : null}

                {tab === 'finance' ? (
                    financeLoading ? (
                        <Box sx={{ display: 'grid', placeItems: 'center', py: 3 }}><CircularProgress size={22} /></Box>
                    ) : finance.unavailable ? (
                        <Alert severity="info" sx={{ py: 0 }}>Needs Finance access. Open Finance → Invoices to manage billing.</Alert>
                    ) : (
                        <Stack spacing={1.25}>
                            <Typography variant="subtitle2" fontWeight={700}>Maintenance</Typography>
                            <Table size="small" sx={{ bgcolor: '#fff' }}>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Period</TableCell>
                                        <TableCell>Due</TableCell>
                                        <TableCell align="right">Amt</TableCell>
                                        <TableCell align="right">Paid</TableCell>
                                        <TableCell align="right">Bal</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {finance.invoices.length === 0 ? (
                                        <TableRow><TableCell colSpan={5}><Typography variant="caption" color="text.secondary">None</Typography></TableCell></TableRow>
                                    ) : finance.invoices.map((inv) => {
                                        const amt = Number(inv.amount || 0);
                                        const paid = Number(inv.amount_paid || 0);
                                        return (
                                            <TableRow key={inv.id || inv._id}>
                                                <TableCell>{inv.period_label || '—'}</TableCell>
                                                <TableCell>{inv.due_date || '—'}</TableCell>
                                                <TableCell align="right">{inr(amt)}</TableCell>
                                                <TableCell align="right">{inr(paid)}</TableCell>
                                                <TableCell align="right">{inr(Math.max(0, amt - paid))}</TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                            <Typography variant="subtitle2" fontWeight={700}>Payments</Typography>
                            <Table size="small" sx={{ bgcolor: '#fff' }}>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Date</TableCell>
                                        <TableCell>Invoice</TableCell>
                                        <TableCell align="right">Amount</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {finance.payments.length === 0 ? (
                                        <TableRow><TableCell colSpan={3}><Typography variant="caption" color="text.secondary">None</Typography></TableCell></TableRow>
                                    ) : finance.payments.map((p, i) => (
                                        <TableRow key={p.id || `${p.invoice_id}-${i}`}>
                                            <TableCell>{(p.created_at || '').slice(0, 10) || '—'}</TableCell>
                                            <TableCell>{p.period_label || p.invoice_id}</TableCell>
                                            <TableCell align="right">{inr(p.amount)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            {finance.nobroker.length ? (() => {
                                const heads = chargeHeadsForRows(finance.nobroker);
                                return (
                                <>
                                    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Typography variant="subtitle2" fontWeight={700}>Raised (NoBroker)</Typography>
                                        {heads.length ? (
                                            <Button
                                                size="small"
                                                onClick={() => setNbSplitOpen((v) => !v)}
                                                startIcon={nbSplitOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                                            >
                                                {nbSplitOpen ? 'Hide split' : 'Show split'}
                                            </Button>
                                        ) : null}
                                    </Stack>
                                    <TableContainer sx={{ bgcolor: '#fff', overflowX: 'auto' }}>
                                        <Table size="small">
                                            <TableHead>
                                                <TableRow>
                                                    <TableCell>Invoice</TableCell>
                                                    <TableCell>Month</TableCell>
                                                    <TableCell align="right">Total</TableCell>
                                                    {nbSplitOpen ? heads.map((head) => (
                                                        <TableCell key={head} align="right" title={head} sx={{ whiteSpace: 'nowrap' }}>
                                                            {shortHead(head)}
                                                        </TableCell>
                                                    )) : null}
                                                </TableRow>
                                            </TableHead>
                                            <TableBody>
                                                {finance.nobroker.map((row) => {
                                                    const map = chargeMap(row);
                                                    return (
                                                        <TableRow key={row.id || row.invoice_number}>
                                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.invoice_number || '—'}</TableCell>
                                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{monthYy(row.billing_month)}</TableCell>
                                                            <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                                                                {inr(chargeTotal(row))}
                                                            </TableCell>
                                                            {nbSplitOpen ? heads.map((head) => {
                                                                const amt = parseMoney(map[head]);
                                                                return (
                                                                    <TableCell key={head} align="right" sx={{ whiteSpace: 'nowrap' }}>
                                                                        {amt ? inr(amt) : '—'}
                                                                    </TableCell>
                                                                );
                                                            }) : null}
                                                        </TableRow>
                                                    );
                                                })}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                </>
                                );
                            })() : null}
                            <Button size="small" href="/finance/invoices-raised.html" target="_blank" rel="noreferrer">
                                Open Finance invoices
                            </Button>
                        </Stack>
                    )
                ) : null}
            </DialogContent>
            <DialogActions>
                <Button size="small" onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
