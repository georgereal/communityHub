import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    IconButton,
    InputAdornment,
    Menu,
    MenuItem,
    Paper,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
    useMediaQuery,
    useTheme,
} from '@mui/material';
import {
    Add as AddIcon,
    DirectionsCar as CarIcon,
    Download as DownloadIcon,
    Edit as EditIcon,
    Close as CloseIcon,
    ExpandLess as ExpandLessIcon,
    ExpandMore as ExpandMoreIcon,
    MoreVert as MoreVertIcon,
    Refresh as RefreshIcon,
    Search as SearchIcon,
    TwoWheeler as BikeIcon,
    Upload as UploadIcon,
} from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portalState } from '../../store.js';
import { TypeEditor } from './InlineUnitEdit.jsx';
import PoolAssignDialog from './PoolAssignDialog.jsx';
import PoolSlotDialog from './PoolSlotDialog.jsx';
import NeighborRentDialog from './NeighborRentDialog.jsx';
import BaseSlotsDialog from './BaseSlotsDialog.jsx';
import CapGate from '../../components/CapGate.jsx';
import {
    addPoolSlot,
    computeParkingSummary,
    deletePoolSlot,
    exportParkingExcel,
    fetchParkingBundle,
    importParkingCsv,
    listFlatRentals,
    listIncomingRentals,
    listParkingUnits,
    listPoolSlots,
    parkingSummaryCards,
    poolSlotLabel,
    sortParkingVehicles,
} from './api.js';
import { effectiveAllocationType } from '../../allocation.js';
import ExcelColHeader from '../../listUi/ExcelColHeader.jsx';

function typeOf(v) {
    return String(v?.type || 'CAR').toUpperCase();
}

const COL_DEFS = [
    { key: 'flat', label: 'Flat', placeholder: 'Contains…', canSort: true, canFilter: true },
    { key: 'cars', label: 'Cars', placeholder: 'Plate, EH, rented…', canSort: true, canFilter: true },
    { key: 'bikes', label: 'Bikes', placeholder: 'Plate, BH, rented…', canSort: true, canFilter: true },
    { key: 'over', label: 'Overallocated', placeholder: 'Plate…', canSort: true, canFilter: true },
    { key: 'slots', label: 'Base slots', placeholder: '1c / 2b', canSort: true, canFilter: false },
    { key: 'status', label: 'Status', placeholder: 'Pass or Violation', canSort: true, canFilter: true },
];

function columnSortValue(unit, key) {
    if (key === 'flat') return String(unit.number || '');
    if (key === 'cars') return columnText(unit, 'CAR');
    if (key === 'bikes') return columnText(unit, 'BIKE');
    if (key === 'over') return columnText(unit, null, true);
    if (key === 'slots') return (Number(unit.car_limit) || 0) * 1000 + (Number(unit.bike_limit) || 0);
    if (key === 'status') return String(unit.parkingStatus || '');
    return '';
}

function columnText(unit, type, overallocated = false) {
    const own = (unit.vehicles || [])
        .filter((v) => !type || typeOf(v) === type)
        .filter((v) => (v.status === 'OVERLIMIT') === overallocated);
    const incoming = (!overallocated && unit?.id)
        ? listIncomingRentals(unit.id).filter((v) => !type || typeOf(v) === type)
        : [];
    const incomingIds = new Set(incoming.map((v) => v.id));
    return [...own, ...incoming]
        .map((v) => `${v.plate || ''} ${poolSlotLabel(v, { incoming: incomingIds.has(v.id) })}`)
        .join(' ')
        .toLowerCase();
}

function PlateChips({ unit, vehicles, type, overallocated = false }) {
    const own = (vehicles || [])
        .filter((v) => !type || typeOf(v) === type)
        .filter((v) => (v.status === 'OVERLIMIT') === overallocated);
    const incoming = (!overallocated && unit?.id)
        ? listIncomingRentals(unit.id).filter((v) => !type || typeOf(v) === type)
        : [];
    const rows = sortParkingVehicles(own, incoming.map((v) => ({ vehicle: v, incoming: true })));
    if (!rows.length) return <Typography variant="body2" color="text.secondary">—</Typography>;
    return (
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {rows.map(({ vehicle: v, incoming }) => {
                const alloc = effectiveAllocationType(v);
                const isBike = typeOf(v) === 'BIKE';
                const tone = v.status === 'OVERLIMIT'
                    ? 'overlimit'
                    : incoming
                        ? 'slot'
                        : alloc === 'COMMON'
                            ? 'pool'
                            : alloc === 'NEIGHBOR'
                                ? 'rented'
                                : v.status === 'INACTIVE'
                                    ? 'dormant'
                                    : 'base';
                const Icon = isBike ? BikeIcon : CarIcon;
                const extra = poolSlotLabel(v, { incoming });
                return (
                    <span
                        key={`${incoming ? 'in' : 'own'}-${v.id}`}
                        className={`parking-vchip parking-vchip--${tone}`}
                        title={extra ? `${v.plate} · ${extra}` : v.plate}
                    >
                        <Icon className="parking-vchip__icon" />
                        <span className="parking-vchip__plate">{v.plate}</span>
                        {extra ? <span className="parking-vchip__meta">{extra}</span> : null}
                    </span>
                );
            })}
        </Stack>
    );
}

function PoolStrip({ title, kind, onEdit, onEditSlot, onAdd, onDelete, compact = false }) {
    const slots = listPoolSlots(kind);
    const [expanded, setExpanded] = useState(false);
    const preview = 2;
    const collapsed = compact && !expanded && slots.length > preview;
    const shown = collapsed ? slots.slice(0, preview) : slots;
    const hidden = Math.max(0, slots.length - shown.length);
    return (
        <Paper sx={{ p: 1.5, mb: 1.5 }}>
            <Stack direction="row" sx={{ mb: 1, justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography fontWeight={700}>{title}</Typography>
                <Stack direction="row" spacing={0.5}>
                    <CapGate cap="parking.update">
                        <Button size="small" onClick={onEdit}>Add vehicle</Button>
                    </CapGate>
                    <CapGate cap="parking.base_slots">
                        <Button size="small" startIcon={<AddIcon />} onClick={onAdd}>Add slot</Button>
                    </CapGate>
                </Stack>
            </Stack>
            {slots.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No {kind === 'bike' ? 'BH' : 'EH'} slots yet.</Typography>
            ) : (
                <>
                <Box className="parking-pool-grid">
                    {shown.map((s) => {
                        const occupied = Boolean(s.occupant || s.assigned_vehicle_id);
                        return (
                            <button
                                key={s.id}
                                type="button"
                                className={`parking-pool-tile${occupied ? ' parking-pool-tile--taken' : ''}`}
                                onClick={() => onEditSlot(s)}
                            >
                                <span className="parking-pool-tile__slot">{s.name}</span>
                                {occupied ? (
                                    <>
                                        <span className="parking-pool-tile__alloc">{s.unit_num || '—'}</span>
                                        <span className="parking-pool-tile__alloc">{s.occupant || 'Assigned'}</span>
                                    </>
                                ) : (
                                    <span className="parking-pool-tile__alloc">Open</span>
                                )}
                                { !occupied ? (
                                    <CapGate cap="parking.delete">
                                        <span
                                            className="parking-pool-tile__remove"
                                            role="button"
                                            tabIndex={0}
                                            title="Delete slot"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDelete(s);
                                            }}
                                        >
                                            ×
                                        </span>
                                    </CapGate>
                                ) : null}
                            </button>
                        );
                    })}
                </Box>
                {compact && slots.length > preview ? (
                    <Button
                        size="small"
                        onClick={() => setExpanded((v) => !v)}
                        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                        sx={{ mt: 0.75 }}
                    >
                        {expanded ? 'Show less' : `Show ${hidden} more`}
                    </Button>
                ) : null}
                </>
            )}
        </Paper>
    );
}

export default function VehicleList() {
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const queryClient = useQueryClient();
    const fileRef = useRef(null);

    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [filter, setFilter] = useState('all');
    const [editingId, setEditingId] = useState(null);
    const [poolKind, setPoolKind] = useState(null);
    const [poolSlot, setPoolSlot] = useState(null);
    const [rentOpen, setRentOpen] = useState(false);
    const [slotsOpen, setSlotsOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [actionError, setActionError] = useState('');
    const [importNote, setImportNote] = useState('');
    const [colFilter, setColFilter] = useState({
        flat: '', cars: '', bikes: '', over: '', slots: '', status: '',
    });
    const [sort, setSort] = useState({ key: 'flat', dir: 'asc' });
    const [moreCards, setMoreCards] = useState(false);
    const [actionsEl, setActionsEl] = useState(null);

    useEffect(() => {
        const t = setTimeout(() => setDebounced(search.trim()), 300);
        return () => clearTimeout(t);
    }, [search]);

    const { isLoading, isFetching, error, dataUpdatedAt } = useQuery({
        queryKey: ['parking-bundle', portalState.access?.activeApartmentId],
        queryFn: fetchParkingBundle,
        staleTime: 30_000,
    });

    const summary = useMemo(
        () => (dataUpdatedAt ? computeParkingSummary() : null),
        [dataUpdatedAt],
    );
    const cards = useMemo(() => parkingSummaryCards(summary), [summary]);
    const MOBILE_CARD_KEYS = ['OVERLIMIT', 'OVERLIMIT_BIKES', 'OCC'];
    const visibleCards = (!isMobile || moreCards)
        ? cards
        : cards.filter((c) => MOBILE_CARD_KEYS.includes(c.key) || (filter !== 'all' && c.key === filter));
    const allRows = useMemo(
        () => (dataUpdatedAt ? listParkingUnits({ search: debounced, filter }) : []),
        [dataUpdatedAt, debounced, filter],
    );
    const rows = useMemo(() => {
        const f = {
            flat: colFilter.flat.trim().toLowerCase(),
            cars: colFilter.cars.trim().toLowerCase(),
            bikes: colFilter.bikes.trim().toLowerCase(),
            over: colFilter.over.trim().toLowerCase(),
            slots: colFilter.slots.trim().toLowerCase(),
            status: colFilter.status.trim().toLowerCase(),
        };
        const filtered = allRows.filter((u) => {
            if (f.flat && !String(u.number || '').toLowerCase().includes(f.flat)) return false;
            if (f.cars && !columnText(u, 'CAR').includes(f.cars)) return false;
            if (f.bikes && !columnText(u, 'BIKE').includes(f.bikes)) return false;
            if (f.over && !columnText(u, null, true).includes(f.over)) return false;
            if (f.slots && !`${u.car_limit || 0}c / ${u.bike_limit || 0}b`.includes(f.slots)) return false;
            if (f.status && !String(u.parkingStatus || '').toLowerCase().includes(f.status)) return false;
            return true;
        });
        if (!sort?.key) return filtered;
        return [...filtered].sort((a, b) => {
            const av = columnSortValue(a, sort.key);
            const bv = columnSortValue(b, sort.key);
            const cmp = typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
            return sort.dir === 'desc' ? -cmp : cmp;
        });
    }, [allRows, colFilter, sort]);
    const emptyListMessage = [debounced, ...Object.values(colFilter)].some((s) => String(s).trim())
        ? 'No flats match these filters.'
        : 'No flats match this view.';
    const rentals = useMemo(() => (dataUpdatedAt ? listFlatRentals() : []), [dataUpdatedAt]);

    const headerMenu = (col) => (
        <ExcelColHeader
            col={col}
            sort={sort}
            filterValue={colFilter[col.key]}
            onSort={(key, dir) => setSort({ key, dir })}
            onFilter={(value) => setColFilter((prev) => ({ ...prev, [col.key]: value }))}
            onClear={(key) => {
                setColFilter((prev) => ({ ...prev, [key]: '' }));
                setSort((prev) => (prev.key === key ? { key: 'flat', dir: 'asc' } : prev));
            }}
        />
    );

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['parking-bundle'] });

    const handleExport = async () => {
        setExporting(true);
        setActionError('');
        try {
            await exportParkingExcel();
        } catch (err) {
            setActionError(err?.message || 'Export failed.');
        } finally {
            setExporting(false);
        }
    };

    const handleImport = async (file) => {
        if (!file) return;
        setImporting(true);
        setActionError('');
        setImportNote('');
        try {
            const out = await importParkingCsv(file);
            setImportNote(`Imported ${out.added} of ${out.total} row(s).${out.errors.length ? ` ${out.errors.length} skipped.` : ''}`);
            invalidate();
        } catch (err) {
            setActionError(err?.message || 'Import failed.');
        } finally {
            setImporting(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    return (
        <Box className="residents-react-page property-app-page">
            <Stack direction="row" sx={{ mb: 1.5, gap: 1, alignItems: 'center', justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                        component="h1"
                        variant={isMobile ? 'subtitle1' : 'h5'}
                        fontWeight={700}
                        noWrap
                    >
                        Parking &amp; Vehicles
                    </Typography>
                    {isMobile ? null : (
                    <Typography variant="body2" color="text.secondary">
                        Edit a flat’s row to add or change vehicle tags. Overallocated vehicles sit in their own column. EH/BH, rent-from-flat, and base slot counts stay separate.
                    </Typography>
                    )}
                </Box>
                {isMobile ? (
                    <>
                        <IconButton
                            size="small"
                            aria-label="Page actions"
                            onClick={(e) => setActionsEl(e.currentTarget)}
                            sx={{ flexShrink: 0 }}
                        >
                            <MoreVertIcon />
                        </IconButton>
                        <Menu
                            anchorEl={actionsEl}
                            open={Boolean(actionsEl)}
                            onClose={() => setActionsEl(null)}
                        >
                            <MenuItem
                                disabled={isFetching}
                                onClick={() => { invalidate(); setActionsEl(null); }}
                            >
                                Refresh
                            </MenuItem>
                            <MenuItem
                                disabled={exporting}
                                onClick={() => { setActionsEl(null); handleExport(); }}
                            >
                                Download Excel
                            </MenuItem>
                            <CapGate cap="parking.update">
                                <MenuItem
                                    disabled={importing}
                                    onClick={() => { setActionsEl(null); fileRef.current?.click(); }}
                                >
                                    Import CSV
                                </MenuItem>
                            </CapGate>
                            <CapGate cap="parking.base_slots">
                                <MenuItem onClick={() => { setActionsEl(null); setSlotsOpen(true); }}>
                                    Base slots
                                </MenuItem>
                            </CapGate>
                            <CapGate cap="parking.update">
                                <MenuItem onClick={() => { setActionsEl(null); setRentOpen(true); }}>
                                    Rent from flat
                                </MenuItem>
                            </CapGate>
                        </Menu>
                    </>
                ) : (
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                    <Tooltip title="Refresh">
                        <span>
                            <IconButton size="small" onClick={() => invalidate()} disabled={isFetching}><RefreshIcon /></IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title="Download Excel">
                        <span>
                            <IconButton size="small" onClick={handleExport} disabled={exporting}>
                                {exporting ? <CircularProgress size={18} /> : <DownloadIcon />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    <CapGate cap="parking.update">
                        <Tooltip title="Import CSV">
                            <span>
                                <IconButton size="small" onClick={() => fileRef.current?.click()} disabled={importing}>
                                    {importing ? <CircularProgress size={18} /> : <UploadIcon />}
                                </IconButton>
                            </span>
                        </Tooltip>
                    </CapGate>
                    <CapGate cap="parking.base_slots">
                        <Button size="small" onClick={() => setSlotsOpen(true)}>Base slots</Button>
                    </CapGate>
                    <CapGate cap="parking.update">
                        <Button size="small" onClick={() => setRentOpen(true)}>Rent from flat</Button>
                    </CapGate>
                </Stack>
                )}
                <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => handleImport(e.target.files?.[0])} />
            </Stack>

            {visibleCards.length ? (
                <>
                <section className="resident-summary" aria-label="Parking summary">
                    {visibleCards.map((c) => {
                        const active = (c.key === 'all' && filter === 'all') || filter === c.key;
                        return (
                            <button
                                key={c.key}
                                type="button"
                                className={`resident-summary-card resident-summary-card--${c.tone || 'default'}${active ? ' resident-summary-card--active' : ''}`}
                                title={c.hint || c.label}
                                onClick={() => setFilter((prev) => (c.key === 'all' || prev === c.key ? 'all' : c.key))}
                            >
                                <span className="resident-summary-card__label">{c.label}</span>
                                <strong className="resident-summary-card__value">{c.value}</strong>
                            </button>
                        );
                    })}
                </section>
                {isMobile && cards.length > visibleCards.length ? (
                    <Button
                        size="small"
                        onClick={() => setMoreCards(true)}
                        startIcon={<ExpandMoreIcon />}
                        sx={{ mb: 1.5, mt: -0.5 }}
                    >
                        Show {cards.length - visibleCards.length} more stats
                    </Button>
                ) : null}
                {isMobile && moreCards ? (
                    <Button
                        size="small"
                        onClick={() => setMoreCards(false)}
                        startIcon={<ExpandLessIcon />}
                        sx={{ mb: 1.5, mt: -0.5 }}
                    >
                        Show fewer stats
                    </Button>
                ) : null}
                </>
            ) : null}

            <PoolStrip
                title="Association car pool (EH)"
                kind="car"
                compact={isMobile}
                onEdit={() => setPoolKind('car')}
                onEditSlot={(s) => setPoolSlot(s)}
                onAdd={() => addPoolSlot('car').then(invalidate).catch((err) => setActionError(err.message))}
                onDelete={(s) => {
                    if (!window.confirm(`Delete pool slot ${s.name}?`)) return;
                    deletePoolSlot(s.id).then(invalidate).catch((err) => setActionError(err.message));
                }}
            />
            <PoolStrip
                title="Association bike pool (BH)"
                kind="bike"
                compact={isMobile}
                onEdit={() => setPoolKind('bike')}
                onEditSlot={(s) => setPoolSlot(s)}
                onAdd={() => addPoolSlot('bike').then(invalidate).catch((err) => setActionError(err.message))}
                onDelete={(s) => {
                    if (!window.confirm(`Delete pool slot ${s.name}?`)) return;
                    deletePoolSlot(s.id).then(invalidate).catch((err) => setActionError(err.message));
                }}
            />
            {rentals.length ? (
                <Paper sx={{ p: 1.5, mb: 1.5, cursor: 'pointer' }} onClick={() => setRentOpen(true)}>
                    <Typography fontWeight={700} sx={{ mb: 1 }}>Flat-to-flat rentals</Typography>
                    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                        {rentals.map((r) => (
                            <Chip key={`${r.vehicleId}`} label={`${r.plate}: ${r.sourceLabel} → ${r.tenantLabel}`} />
                        ))}
                    </Stack>
                </Paper>
            ) : null}

            <TextField
                fullWidth
                size="small"
                placeholder="Search flat or plate…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                slotProps={{
                    input: {
                        startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
                    },
                }}
                sx={{ mb: 2, bgcolor: '#fff', borderRadius: 2, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
            />

            {actionError ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError('')}>{actionError}</Alert> : null}
            {importNote ? <Alert severity="success" sx={{ mb: 2 }} onClose={() => setImportNote('')}>{importNote}</Alert> : null}
            {error ? <Alert severity="error" sx={{ mb: 2 }}>{error.message}</Alert> : null}

            {isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : isMobile ? (
                <Stack spacing={1.25}>
                    <Paper variant="outlined" sx={{ p: 1, overflowX: 'auto' }}>
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                            {COL_DEFS.map((col) => <Box key={col.key}>{headerMenu(col)}</Box>)}
                        </Stack>
                    </Paper>
                    {rows.length === 0 ? (
                    <Paper sx={{ p: 4, textAlign: 'center' }}>
                        <Typography color="text.secondary">{emptyListMessage}</Typography>
                    </Paper>
                    ) : rows.map((u) => (
                        <Paper key={u.id} sx={{ p: 1.5 }}>
                            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                                <Typography fontWeight={700}>{u.number}</Typography>
                                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">{`${u.car_limit || 0}C / ${u.bike_limit || 0}B`}</Typography>
                                    <IconButton size="small" onClick={() => setEditingId((id) => (id === u.id ? null : u.id))}>
                                        {editingId === u.id ? <CloseIcon fontSize="small" /> : <EditIcon fontSize="small" />}
                                    </IconButton>
                                </Stack>
                            </Stack>
                            {editingId === u.id ? (
                                <Stack spacing={1} sx={{ mt: 1 }}>
                                    <TypeEditor title="Cars" type="CAR" unit={u} onSaved={invalidate} setError={setActionError} />
                                    <TypeEditor title="Bikes" type="BIKE" unit={u} onSaved={invalidate} setError={setActionError} />
                                    <Typography variant="caption" color="error">Overallocated</Typography>
                                    <PlateChips unit={u} vehicles={u.vehicles} overallocated />
                                </Stack>
                            ) : (
                                <>
                                    <Typography variant="caption" color="text.secondary">Cars</Typography>
                                    <PlateChips unit={u} vehicles={u.vehicles} type="CAR" />
                                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Bikes</Typography>
                                    <PlateChips unit={u} vehicles={u.vehicles} type="BIKE" />
                                    <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>Overallocated</Typography>
                                    <PlateChips unit={u} vehicles={u.vehicles} overallocated />
                                </>
                            )}
                        </Paper>
                    ))}
                </Stack>
            ) : (
                <TableContainer component={Paper}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                {COL_DEFS.map((col) => (
                                    <TableCell key={col.key} sx={{ whiteSpace: 'nowrap' }}>{headerMenu(col)}</TableCell>
                                ))}
                                <TableCell align="right" />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={7}>
                                        <Typography color="text.secondary">{emptyListMessage}</Typography>
                                    </TableCell>
                                </TableRow>
                            ) : rows.map((u) => (
                                <TableRow key={u.id} hover selected={editingId === u.id}>
                                    <TableCell><Typography fontWeight={600}>{u.number}</Typography></TableCell>
                                    <TableCell>
                                        {editingId === u.id ? (
                                            <TypeEditor type="CAR" unit={u} onSaved={invalidate} setError={setActionError} />
                                        ) : (
                                            <PlateChips unit={u} vehicles={u.vehicles} type="CAR" />
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {editingId === u.id ? (
                                            <TypeEditor type="BIKE" unit={u} onSaved={invalidate} setError={setActionError} />
                                        ) : (
                                            <PlateChips unit={u} vehicles={u.vehicles} type="BIKE" />
                                        )}
                                    </TableCell>
                                    <TableCell><PlateChips unit={u} vehicles={u.vehicles} overallocated /></TableCell>
                                    <TableCell>{`${u.car_limit || 0}C / ${u.bike_limit || 0}B`}</TableCell>
                                    <TableCell>
                                        <Chip size="small" color={u.hasViolation ? 'error' : u.active.length ? 'success' : 'warning'} label={u.parkingStatus} />
                                    </TableCell>
                                    <TableCell align="right">
                                        <Tooltip title={editingId === u.id ? 'Done' : 'Edit in row'}>
                                            <IconButton size="small" onClick={() => setEditingId((id) => (id === u.id ? null : u.id))}>
                                                {editingId === u.id ? <CloseIcon fontSize="small" /> : <EditIcon fontSize="small" />}
                                            </IconButton>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            {!isLoading && rows.length > 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    {rows.length} flat{rows.length === 1 ? '' : 's'}
                </Typography>
            ) : null}

            <PoolAssignDialog
                open={Boolean(poolKind)}
                kind={poolKind || 'car'}
                onClose={() => setPoolKind(null)}
                onSaved={invalidate}
            />
            <PoolSlotDialog
                open={Boolean(poolSlot)}
                slot={poolSlot}
                onClose={() => setPoolSlot(null)}
                onSaved={invalidate}
            />
            <NeighborRentDialog open={rentOpen} onClose={() => setRentOpen(false)} onSaved={invalidate} />
            <BaseSlotsDialog open={slotsOpen} onClose={() => setSlotsOpen(false)} onSaved={invalidate} />
        </Box>
    );
}
