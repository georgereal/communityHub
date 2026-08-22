import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
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
    Delete as DeleteIcon,
    Download as DownloadIcon,
    Edit as EditIcon,
    ExpandLess as ExpandLessIcon,
    ExpandMore as ExpandMoreIcon,
    MoreVert as MoreVertIcon,
    Refresh as RefreshIcon,
    Search as SearchIcon,
    Upload as UploadIcon,
    Visibility as ViewIcon,
} from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portalState } from '../../store.js';
import UnitFormDialog from './UnitFormDialog.jsx';
import UnitDetailDialog from './UnitDetailDialog.jsx';
import UnitImportDialog from './UnitImportDialog.jsx';
import CapGate from '../../components/CapGate.jsx';
import { can } from '../../capabilities.js';
import {
    deleteFlatWithResidents,
    downloadUnitsTemplate,
    fetchUnitsBundle,
    flatDeleteConfirmMessage,
    listDirectoryUnits,
    occupancyLabel,
    unitSummaryCards,
} from './api.js';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';

function RowMenu({ unit, onView, onEdit, onDelete }) {
    const [anchor, setAnchor] = useState(null);
    return (
        <>
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }}>
                <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
                <MenuItem onClick={() => { setAnchor(null); onView(unit); }}>
                    <ViewIcon fontSize="small" sx={{ mr: 1 }} /> View
                </MenuItem>
                <CapGate cap="units.update">
                    <MenuItem onClick={() => { setAnchor(null); onEdit(unit); }}>
                        <EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit
                    </MenuItem>
                </CapGate>
                <CapGate cap="units.delete">
                    <MenuItem onClick={() => { setAnchor(null); onDelete(unit); }}>
                        <DeleteIcon fontSize="small" sx={{ mr: 1 }} color="error" /> Delete flat
                    </MenuItem>
                </CapGate>
            </Menu>
        </>
    );
}

const UNIT_COLS = [
    { key: 'flat', label: 'Flat', canSort: true, canFilter: true },
    { key: 'block', label: 'Block', canSort: true, canFilter: true },
    { key: 'type', label: 'Type', canSort: true, canFilter: true, placeholder: 'BHK…' },
    { key: 'status', label: 'Status', canSort: true, canFilter: true },
    { key: 'owners', label: 'Owners', canSort: true, canFilter: true },
    { key: 'tenants', label: 'Tenants', canSort: true, canFilter: true },
    { key: 'parking', label: 'Parking', canSort: true, canFilter: false },
];
const EMPTY_UNIT_FILTER = Object.fromEntries(UNIT_COLS.map((c) => [c.key, '']));
const MOBILE_UNIT_CARDS = ['all', 'OWNER_OCCUPIED', 'VACANT'];

function peopleNames(people) {
    return (people || []).map((p) => p.full_name).filter(Boolean).join(', ') || '';
}

function unitColText(u, key) {
    if (key === 'flat') return u.number || '';
    if (key === 'block') return u.blockLabel || '';
    if (key === 'type') return u.bhk || '';
    if (key === 'status') return occupancyLabel(u.occupancy) || '';
    if (key === 'owners') return peopleNames(u.owners);
    if (key === 'tenants') return peopleNames(u.tenants);
    if (key === 'parking') return `${u.car_limit ?? 0}c / ${u.bike_limit ?? 0}b`;
    return '';
}

function unitColSort(u, key) {
    if (key === 'parking') return (Number(u.car_limit) || 0) * 1000 + (Number(u.bike_limit) || 0);
    return unitColText(u, key);
}

export default function UnitList() {
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const queryClient = useQueryClient();

    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [occupancy, setOccupancy] = useState('');
    const [formOpen, setFormOpen] = useState(false);
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailMode, setDetailMode] = useState('view');
    const [importOpen, setImportOpen] = useState(false);
    const [editUnit, setEditUnit] = useState(null);
    const [deleteUnit, setDeleteUnit] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [actionError, setActionError] = useState('');
    const [moreCards, setMoreCards] = useState(false);
    const [actionsEl, setActionsEl] = useState(null);
    const [colFilter, setColFilter] = useState(EMPTY_UNIT_FILTER);
    const [sort, setSort] = useState({ key: 'flat', dir: 'asc' });

    useEffect(() => {
        const t = setTimeout(() => setDebounced(search.trim()), 300);
        return () => clearTimeout(t);
    }, [search]);

    const { isLoading, isFetching, error, dataUpdatedAt } = useQuery({
        queryKey: ['units-bundle', portalState.access?.activeApartmentId],
        queryFn: fetchUnitsBundle,
        staleTime: 30_000,
    });

    const cards = useMemo(() => (dataUpdatedAt ? unitSummaryCards() : []), [dataUpdatedAt]);
    const visibleCards = (!isMobile || moreCards)
        ? cards
        : cards.filter((c) => MOBILE_UNIT_CARDS.includes(c.key) || (occupancy && c.key === occupancy));
    const listed = useMemo(
        () => (dataUpdatedAt ? listDirectoryUnits({ search: debounced, occupancy }) : []),
        [dataUpdatedAt, debounced, occupancy],
    );
    const rows = useMemo(
        () => sortAndFilterRows(listed, { filters: colFilter, sort, getText: unitColText, getSort: unitColSort }),
        [listed, colFilter, sort],
    );

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['units-bundle'] });

    const names = (people) => peopleNames(people) || '—';

    const openView = (u) => { setEditUnit(u); setDetailMode('view'); setDetailOpen(true); };
    const openEdit = (u) => { setEditUnit(u); setDetailMode('edit'); setDetailOpen(true); };

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
                        Unit Directory
                    </Typography>
                    {isMobile ? null : (
                        <Typography variant="body2" color="text.secondary">Flat master data — area, slots, occupancy.</Typography>
                    )}
                </Box>
                {isMobile ? (
                    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
                        <CapGate cap="units.create">
                            <Button
                                variant="contained"
                                size="small"
                                sx={{ minWidth: 0, px: 1.1 }}
                                onClick={() => { setEditUnit(null); setFormOpen(true); }}
                            >
                                <AddIcon fontSize="small" />
                            </Button>
                        </CapGate>
                        <IconButton size="small" aria-label="Page actions" onClick={(e) => setActionsEl(e.currentTarget)}>
                            <MoreVertIcon />
                        </IconButton>
                        <Menu anchorEl={actionsEl} open={Boolean(actionsEl)} onClose={() => setActionsEl(null)}>
                            <MenuItem disabled={isFetching} onClick={() => { invalidate(); setActionsEl(null); }}>Refresh</MenuItem>
                            <MenuItem
                                disabled={exporting || isLoading}
                                onClick={async () => {
                                    setActionsEl(null);
                                    setExporting(true);
                                    try { await downloadUnitsTemplate(); }
                                    catch (err) { setActionError(err?.message || 'Download failed.'); }
                                    finally { setExporting(false); }
                                }}
                            >
                                Download template
                            </MenuItem>
                            <CapGate cap="units.create">
                                <MenuItem onClick={() => { setActionsEl(null); setImportOpen(true); }}>Import Excel</MenuItem>
                            </CapGate>
                        </Menu>
                    </Stack>
                ) : (
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
                    <Tooltip title="Refresh">
                        <span>
                            <IconButton size="small" onClick={invalidate} disabled={isFetching}>
                                {isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title="Download template">
                        <span>
                            <IconButton
                                size="small"
                                disabled={exporting || isLoading}
                                onClick={async () => {
                                    setExporting(true);
                                    try { await downloadUnitsTemplate(); }
                                    catch (err) { setActionError(err?.message || 'Download failed.'); }
                                    finally { setExporting(false); }
                                }}
                            >
                                {exporting ? <CircularProgress size={18} /> : <DownloadIcon fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    <CapGate cap="units.create">
                        <Tooltip title="Import Excel">
                            <IconButton size="small" onClick={() => setImportOpen(true)}>
                                <UploadIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    </CapGate>
                    <CapGate cap="units.create">
                        <Tooltip title="Add flat">
                            <Button
                                variant="contained"
                                size="small"
                                sx={{ minWidth: 0, px: 1.1, ml: 0.5 }}
                                onClick={() => { setEditUnit(null); setFormOpen(true); }}
                            >
                                <AddIcon fontSize="small" />
                                <Box component="span" sx={{ ml: 0.5, display: { xs: 'none', sm: 'inline' } }}>Add</Box>
                            </Button>
                        </Tooltip>
                    </CapGate>
                </Stack>
                )}
            </Stack>

            {visibleCards.length ? (
                <>
                <section className="resident-summary" aria-label="Unit occupancy summary">
                    {visibleCards.map((c) => {
                        const active = (c.key === 'all' && !occupancy) || occupancy === c.key;
                        return (
                            <button
                                key={c.key}
                                type="button"
                                className={`resident-summary-card resident-summary-card--${c.tone || 'default'}${active ? ' resident-summary-card--active' : ''}`}
                                title={c.hint || c.label}
                                onClick={() => setOccupancy((prev) => (c.key === 'all' || prev === c.key ? '' : c.key))}
                            >
                                <span className="resident-summary-card__label">{c.label}</span>
                                <strong className="resident-summary-card__value">{c.value}</strong>
                                {c.sub ? <span className="resident-summary-card__sub">{c.sub}</span> : null}
                            </button>
                        );
                    })}
                </section>
                {isMobile && cards.length > visibleCards.length ? (
                    <Button size="small" onClick={() => setMoreCards(true)} startIcon={<ExpandMoreIcon />} sx={{ mb: 1.5, mt: -0.5 }}>
                        Show {cards.length - visibleCards.length} more stats
                    </Button>
                ) : null}
                {isMobile && moreCards ? (
                    <Button size="small" onClick={() => setMoreCards(false)} startIcon={<ExpandLessIcon />} sx={{ mb: 1.5, mt: -0.5 }}>
                        Show fewer stats
                    </Button>
                ) : null}
                </>
            ) : null}

            <TextField
                fullWidth
                size="small"
                placeholder="Search flat, block, BHK, name…"
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
            {error ? <Alert severity="error" sx={{ mb: 2 }}>{error.message}</Alert> : null}

            {isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : isMobile ? (
                rows.length === 0 ? (
                    <Paper sx={{ p: 4, textAlign: 'center' }}>
                        <Typography color="text.secondary">No flats match this view.</Typography>
                    </Paper>
                ) : (
                <Stack spacing={1.25}>
                    {rows.map((u) => (
                        <Paper key={u.id} sx={{ p: 1.5 }} onClick={() => openView(u)}>
                            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                                <Box>
                                    <Typography fontWeight={700}>{u.number}</Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        {u.blockLabel || '—'} · {u.bhk || '—'}
                                    </Typography>
                                </Box>
                                <RowMenu
                                    unit={u}
                                    onView={openView}
                                    onEdit={openEdit}
                                    onDelete={setDeleteUnit}
                                />
                            </Stack>
                            <Chip size="small" sx={{ mt: 1 }} label={occupancyLabel(u.occupancy)} />
                        </Paper>
                    ))}
                </Stack>
                )
            ) : (
                <TableContainer component={Paper}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                {UNIT_COLS.map((col) => (
                                    <TableCell key={col.key} sx={{ whiteSpace: 'nowrap' }}>{headerMenu(col)}</TableCell>
                                ))}
                                <TableCell align="right"> </TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={8}>
                                        <Typography color="text.secondary">No flats match this view.</Typography>
                                    </TableCell>
                                </TableRow>
                            ) : rows.map((u) => (
                                <TableRow key={u.id} hover sx={{ cursor: 'pointer' }} onClick={() => openView(u)}>
                                    <TableCell><Typography fontWeight={600}>{u.number}</Typography></TableCell>
                                    <TableCell>{u.blockLabel || '—'}</TableCell>
                                    <TableCell>{u.bhk || '—'}</TableCell>
                                    <TableCell><Chip size="small" label={occupancyLabel(u.occupancy)} /></TableCell>
                                    <TableCell>{names(u.owners)}</TableCell>
                                    <TableCell>{names(u.tenants)}</TableCell>
                                    <TableCell>{u.car_limit ?? 0}C / {u.bike_limit ?? 0}B</TableCell>
                                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                        <RowMenu
                                            unit={u}
                                            onView={openView}
                                            onEdit={openEdit}
                                            onDelete={setDeleteUnit}
                                        />
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

            <UnitFormDialog
                open={formOpen}
                unit={null}
                onClose={() => setFormOpen(false)}
                onSaved={invalidate}
            />
            <UnitDetailDialog
                open={detailOpen}
                unit={editUnit}
                mode={detailMode}
                onClose={() => setDetailOpen(false)}
                onSaved={invalidate}
                onModeChange={setDetailMode}
            />
            <UnitImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={invalidate} />

            <Dialog open={Boolean(deleteUnit)} onClose={() => setDeleteUnit(null)} fullWidth maxWidth="sm">
                <DialogTitle>Delete flat?</DialogTitle>
                <DialogContent>
                    <Typography whiteSpace="pre-wrap">
                        {deleteUnit ? flatDeleteConfirmMessage(deleteUnit.number, [...(deleteUnit.owners || []), ...(deleteUnit.tenants || [])]) : ''}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteUnit(null)}>Cancel</Button>
                    <Button
                        color="error"
                        variant="contained"
                        onClick={async () => {
                            await deleteFlatWithResidents(deleteUnit.number);
                            setDeleteUnit(null);
                            invalidate();
                        }}
                    >
                        Delete
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
