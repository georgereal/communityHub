import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    FormControlLabel,
    Checkbox,
    IconButton,
    InputAdornment,
    InputLabel,
    Menu,
    MenuItem,
    Paper,
    Select,
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
    FilterList as FilterListIcon,
    MoreVert as MoreVertIcon,
    Refresh as RefreshIcon,
    Search as SearchIcon,
    Upload as UploadIcon,
    Visibility as ViewIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import useListQueryParams from '../hooks/useListQueryParams.js';
import { navigateToDetail } from '../utils/listNavigation.js';
import ResidentFormDialog from '../components/ResidentFormDialog.jsx';
import ResidentImportDialog from '../components/ResidentImportDialog.jsx';
import {
    OCCUPANCY_SUMMARY,
    canEditResidents,
    deleteFlat,
    deleteResident,
    exportResidentsExcel,
    fetchResidentsBundle,
    flatDeleteConfirmMessage,
    getBlocks,
    getResidentBlock,
    listResidentsFiltered,
    listUnitGroups,
    occupancyForUnit,
    buildSummaryCards,
} from '../api.js';
import { portalState } from '../../store.js';
import { getSelectedBlock, setSelectedBlock } from '../../blockFilter.js';
import ExcelColHeader, { sortAndFilterRows } from '../../listUi/ExcelColHeader.jsx';

const LIST_DEFAULTS = {
    search: '',
    kind: '',
    residency: '',
    primary: '',
    block: '',
    occupancy: '',
};

const SEARCH_DEBOUNCE_MS = 350;

function KindChip({ kind }) {
    const k = String(kind || '').toUpperCase();
    return (
        <Chip
            size="small"
            label={k === 'TENANT' ? 'Tenant' : 'Owner'}
            color={k === 'TENANT' ? 'info' : 'default'}
            variant={k === 'TENANT' ? 'filled' : 'outlined'}
        />
    );
}

function RowMenu({
    resident,
    canEdit,
    onView,
    onEdit,
    onDeletePerson,
    onDeleteFlat,
}) {
    const [anchor, setAnchor] = useState(null);
    return (
        <>
            <IconButton
                size="small"
                onClick={(e) => {
                    e.stopPropagation();
                    setAnchor(e.currentTarget);
                }}
            >
                <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
                anchorEl={anchor}
                open={Boolean(anchor)}
                onClose={() => setAnchor(null)}
                onClick={(e) => e.stopPropagation()}
            >
                <MenuItem onClick={() => { setAnchor(null); onView(resident); }}>
                    <ViewIcon fontSize="small" sx={{ mr: 1 }} /> View
                </MenuItem>
                {canEdit ? (
                    <MenuItem onClick={() => { setAnchor(null); onEdit(resident); }}>
                        <EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit
                    </MenuItem>
                ) : null}
                {canEdit ? (
                    <MenuItem onClick={() => { setAnchor(null); onDeletePerson(resident); }}>
                        <DeleteIcon fontSize="small" sx={{ mr: 1 }} /> Delete person
                    </MenuItem>
                ) : null}
                {canEdit ? (
                    <MenuItem onClick={() => { setAnchor(null); onDeleteFlat(resident); }}>
                        <DeleteIcon fontSize="small" sx={{ mr: 1 }} color="error" /> Delete flat…
                    </MenuItem>
                ) : null}
            </Menu>
        </>
    );
}

const RESIDENT_COLS = [
    { key: 'name', label: 'Name', canSort: true, canFilter: true },
    { key: 'flat', label: 'Flat', canSort: true, canFilter: true },
    { key: 'block', label: 'Block', canSort: true, canFilter: true },
    { key: 'kind', label: 'Kind', canSort: true, canFilter: true, placeholder: 'Owner / Tenant' },
    { key: 'flags', label: 'Flags', canSort: true, canFilter: true, placeholder: 'Primary / Non-residing' },
    { key: 'occupancy', label: 'Occupancy', canSort: true, canFilter: true },
    { key: 'phone', label: 'Phone', canSort: true, canFilter: true },
    { key: 'email', label: 'Email', canSort: true, canFilter: true },
];
const EMPTY_COL_FILTER = Object.fromEntries(RESIDENT_COLS.map((c) => [c.key, '']));
const MOBILE_CARD_KEYS = ['all', 'OWNER_OCCUPIED', 'VACANT'];

function residentColText(r, key) {
    if (key === 'name') return r.full_name || '';
    if (key === 'flat') return r.unit_number || '';
    if (key === 'block') return getResidentBlock(r.unit_number) || '';
    if (key === 'kind') return String(r.kind || 'OWNER').toUpperCase() === 'TENANT' ? 'tenant' : 'owner';
    if (key === 'flags') return `${r.is_primary ? 'primary' : ''} ${r.is_residing === false ? 'non-residing' : ''}`;
    if (key === 'occupancy') {
        const occ = occupancyForUnit(r.unit_number);
        return occ?.meta?.shortLabel || occ?.meta?.label || '';
    }
    if (key === 'phone') return r.phone || '';
    if (key === 'email') return r.email || '';
    return '';
}

export default function ResidentList() {
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const queryClient = useQueryClient();
    const canEdit = canEditResidents();

    const { values: listParams, setParams: setListParams, clearParams } = useListQueryParams(LIST_DEFAULTS);

    const [searchQuery, setSearchQuery] = useState(listParams.search || '');
    const [filterOpen, setFilterOpen] = useState(false);
    const [localFilters, setLocalFilters] = useState({
        kind: listParams.kind || '',
        residency: listParams.residency || '',
        primary: listParams.primary || '',
        block: listParams.block || getSelectedBlock() || '',
        occupancy: listParams.occupancy || '',
    });
    const [formOpen, setFormOpen] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [editResident, setEditResident] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [actionError, setActionError] = useState('');
    const [moreCards, setMoreCards] = useState(false);
    const [actionsEl, setActionsEl] = useState(null);
    const [colFilter, setColFilter] = useState(EMPTY_COL_FILTER);
    const [sort, setSort] = useState({ key: 'flat', dir: 'asc' });

    useEffect(() => {
        const t = setTimeout(() => {
            setListParams({ search: searchQuery.trim() });
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [searchQuery, setListParams]);

    useEffect(() => {
        setSearchQuery(listParams.search || '');
        setLocalFilters({
            kind: listParams.kind || '',
            residency: listParams.residency || '',
            primary: listParams.primary || '',
            block: listParams.block || '',
            occupancy: listParams.occupancy || '',
        });
        if (listParams.block !== undefined) {
            setSelectedBlock(listParams.block || '');
        }
    }, [
        listParams.search,
        listParams.kind,
        listParams.residency,
        listParams.primary,
        listParams.block,
        listParams.occupancy,
    ]);

    const { isLoading, isFetching, error, dataUpdatedAt } = useQuery({
        queryKey: ['residents-bundle', portalState.access?.activeApartmentId],
        queryFn: fetchResidentsBundle,
        staleTime: 30_000,
    });

    const filterArgs = useMemo(() => ({
        search: listParams.search,
        kind: listParams.kind,
        residency: listParams.residency,
        primaryOnly: listParams.primary === '1',
        block: listParams.block,
        occupancy: listParams.occupancy,
    }), [listParams]);

    const { rows: filteredRows, hiddenCount } = useMemo(() => {
        if (!dataUpdatedAt) return { rows: [], hiddenCount: 0 };
        return listResidentsFiltered(filterArgs);
    }, [dataUpdatedAt, filterArgs]);
    const rows = useMemo(
        () => sortAndFilterRows(filteredRows, {
            filters: colFilter,
            sort,
            getText: residentColText,
        }),
        [filteredRows, colFilter, sort],
    );

    /** Occupancy summary for header boxes (block-scoped, not search-filtered). */
    const occupancyCounts = useMemo(() => {
        if (!dataUpdatedAt) return null;
        return listUnitGroups({
            block: listParams.block,
            search: '',
            kind: '',
            residency: '',
            primaryOnly: false,
            occupancy: '',
        }).summary;
    }, [dataUpdatedAt, listParams.block]);

    const summaryCards = useMemo(
        () => (occupancyCounts ? buildSummaryCards(occupancyCounts) : []),
        [occupancyCounts],
    );
    const visibleCards = (!isMobile || moreCards)
        ? summaryCards
        : summaryCards.filter((c) => MOBILE_CARD_KEYS.includes(c.key) || (listParams.occupancy && c.key === listParams.occupancy));

    const toggleSummaryFilter = (key) => {
        if (key === 'all' || listParams.occupancy === key) {
            setListParams({ occupancy: '' });
            return;
        }
        setListParams({ occupancy: key });
    };

    const activeFiltersCount = [
        listParams.kind,
        listParams.residency,
        listParams.primary,
        listParams.block,
        listParams.occupancy,
    ].filter(Boolean).length;

    const blocks = dataUpdatedAt ? getBlocks() : [];
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['residents-bundle'] });

    const openDetail = (id) => navigateToDetail(navigate, location, `/${id}`);
    const openEdit = (r) => {
        setEditResident(r);
        setFormOpen(true);
    };

    const applyFilters = () => {
        setSelectedBlock(localFilters.block || '');
        setListParams({
            kind: localFilters.kind,
            residency: localFilters.residency,
            primary: localFilters.primary,
            block: localFilters.block,
            occupancy: localFilters.occupancy,
        });
        setFilterOpen(false);
    };

    const clearFilters = () => {
        setLocalFilters({ kind: '', residency: '', primary: '', block: '', occupancy: '' });
        setSelectedBlock('');
        clearParams();
        setSearchQuery('');
        setFilterOpen(false);
    };

    const handleExport = async () => {
        setExporting(true);
        setActionError('');
        try {
            await exportResidentsExcel(filterArgs);
        } catch (err) {
            setActionError(err?.message || 'Export failed.');
        } finally {
            setExporting(false);
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        setActionError('');
        try {
            if (deleteTarget.type === 'person') {
                await deleteResident(deleteTarget.resident.id);
            } else {
                await deleteFlat(deleteTarget.unit);
            }
            setDeleteTarget(null);
            invalidate();
        } catch (err) {
            setActionError(err?.message || 'Delete failed.');
            setDeleteTarget(null);
        }
    };

    const occupancyFilterOptions = useMemo(() => {
        const base = [
            { value: '', label: 'All occupancy' },
            { value: 'OWNER_OCCUPIED', label: 'Owner residing' },
            { value: 'TENANT_OCCUPIED', label: 'Tenant occupied' },
            { value: 'VACANT', label: 'Vacant' },
            { value: 'NON_ALLOTABLE', label: 'Non-allotable' },
            { value: 'no_owner', label: 'No owner on record' },
        ];
        if (occupancyCounts?.underRenovation) {
            base.push({ value: 'UNDER_RENOVATION', label: 'Under renovation' });
        }
        if (occupancyCounts?.locked) {
            base.push({ value: 'LOCKED', label: 'Locked' });
        }
        if (occupancyCounts?.developerHold) {
            base.push({ value: 'DEVELOPER_HOLD', label: 'Developer hold' });
        }
        return base;
    }, [occupancyCounts]);

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
        <Box className="residents-react-page">
            <Stack direction="row" sx={{ mb: 1.5, gap: 1, alignItems: 'center', justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                        component="h1"
                        variant={isMobile ? 'subtitle1' : 'h5'}
                        fontWeight={700}
                        noWrap
                    >
                        Residents
                    </Typography>
                    {isMobile ? null : (
                        <Typography variant="body2" color="text.secondary">
                            Owners and tenants for this society.
                        </Typography>
                    )}
                </Box>
                {isMobile ? (
                    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
                        {canEdit ? (
                            <Button
                                variant="contained"
                                size="small"
                                sx={{ minWidth: 0, px: 1.1 }}
                                onClick={() => { setEditResident(null); setFormOpen(true); }}
                            >
                                <AddIcon fontSize="small" />
                            </Button>
                        ) : null}
                        <IconButton size="small" aria-label="Page actions" onClick={(e) => setActionsEl(e.currentTarget)}>
                            <MoreVertIcon />
                        </IconButton>
                        <Menu anchorEl={actionsEl} open={Boolean(actionsEl)} onClose={() => setActionsEl(null)}>
                            <MenuItem disabled={isFetching} onClick={() => { invalidate(); setActionsEl(null); }}>Refresh</MenuItem>
                            <MenuItem disabled={exporting || isLoading} onClick={() => { setActionsEl(null); handleExport(); }}>Export Excel</MenuItem>
                            {canEdit ? (
                                <MenuItem onClick={() => { setActionsEl(null); setImportOpen(true); }}>Import file</MenuItem>
                            ) : null}
                            <MenuItem onClick={() => { setActionsEl(null); setFilterOpen(true); }}>
                                Filters{activeFiltersCount ? ` (${activeFiltersCount})` : ''}
                            </MenuItem>
                        </Menu>
                    </Stack>
                ) : (
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
                    <Tooltip title="Refresh">
                        <span>
                            <IconButton size="small" onClick={invalidate} disabled={isFetching} aria-label="Refresh">
                                {isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title="Export Excel">
                        <span>
                            <IconButton
                                size="small"
                                onClick={handleExport}
                                disabled={exporting || isLoading}
                                aria-label="Export"
                            >
                                {exporting ? <CircularProgress size={18} /> : <DownloadIcon fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    {canEdit ? (
                        <Tooltip title="Import file">
                            <IconButton size="small" onClick={() => setImportOpen(true)} aria-label="Import">
                                <UploadIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    ) : null}
                    <Tooltip title="Filters">
                        <Badge color="primary" overlap="circular" badgeContent={activeFiltersCount || null}>
                            <IconButton size="small" onClick={() => setFilterOpen(true)} aria-label="Filters">
                                <FilterListIcon fontSize="small" />
                            </IconButton>
                        </Badge>
                    </Tooltip>
                    {canEdit ? (
                        <Tooltip title="Add resident">
                            <Button
                                variant="contained"
                                size="small"
                                sx={{ minWidth: 0, px: 1.1, ml: 0.5 }}
                                onClick={() => {
                                    setEditResident(null);
                                    setFormOpen(true);
                                }}
                            >
                                <AddIcon fontSize="small" />
                                <Box component="span" sx={{ ml: 0.5, display: { xs: 'none', sm: 'inline' } }}>Add</Box>
                            </Button>
                        </Tooltip>
                    ) : null}
                </Stack>
                )}
            </Stack>

            {visibleCards.length ? (
                <>
                <section className="resident-summary" aria-label="Occupancy summary">
                    {visibleCards.map((c) => {
                        const active = (c.key === 'all' && !listParams.occupancy)
                            || (c.key !== 'all' && listParams.occupancy === c.key);
                        return (
                            <button
                                key={c.key}
                                type="button"
                                className={`resident-summary-card resident-summary-card--${c.tone || 'default'}${active ? ' resident-summary-card--active' : ''}`}
                                title={c.hint || `Filter by ${c.label}`}
                                onClick={() => toggleSummaryFilter(c.key)}
                            >
                                <span className="resident-summary-card__label">{c.label}</span>
                                <strong className="resident-summary-card__value">{c.value}</strong>
                                {c.sub ? <span className="resident-summary-card__sub">{c.sub}</span> : null}
                            </button>
                        );
                    })}
                    {isMobile ? null : (
                    <p className="resident-summary-legend">
                        <strong>Vacant</strong> = nobody residing.
                        {' '}
                        <strong>Non-allotable</strong> = no owner and no tenant on record.
                        Click a box to filter the list.
                    </p>
                    )}
                </section>
                {isMobile && summaryCards.length > visibleCards.length ? (
                    <Button size="small" onClick={() => setMoreCards(true)} startIcon={<ExpandMoreIcon />} sx={{ mb: 1.5, mt: -0.5 }}>
                        Show {summaryCards.length - visibleCards.length} more stats
                    </Button>
                ) : null}
                {isMobile && moreCards ? (
                    <Button size="small" onClick={() => setMoreCards(false)} startIcon={<ExpandLessIcon />} sx={{ mb: 1.5, mt: -0.5 }}>
                        Show fewer stats
                    </Button>
                ) : null}
                </>
            ) : null}

            <Paper sx={{ p: 0, mb: 2, border: 'none', boxShadow: 'none', bgcolor: 'transparent' }}>
                <TextField
                    fullWidth
                    size="small"
                    placeholder="Search name, flat, phone, email…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    slotProps={{
                        input: {
                            startAdornment: (
                                <InputAdornment position="start">
                                    <SearchIcon fontSize="small" />
                                </InputAdornment>
                            ),
                        },
                    }}
                    sx={{
                        bgcolor: '#fff',
                        borderRadius: 2,
                        '& .MuiOutlinedInput-root': { borderRadius: 2 },
                    }}
                />
            </Paper>

            {actionError ? (
                <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError('')}>{actionError}</Alert>
            ) : null}
            {error ? (
                <Alert severity="error" sx={{ mb: 2 }}>{error.message || 'Failed to load residents.'}</Alert>
            ) : null}

            {isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
                    <CircularProgress />
                </Box>
            ) : isMobile ? (
                rows.length === 0 ? (
                    <Paper sx={{ p: 4, textAlign: 'center' }}>
                        <Typography color="text.secondary">
                            {activeFiltersCount || listParams.search || Object.values(colFilter).some((v) => String(v).trim())
                                ? 'No residents match these filters.'
                                : 'No residents recorded yet. Use Import or Add resident to get started.'}
                        </Typography>
                        {activeFiltersCount || listParams.search ? (
                            <Button sx={{ mt: 1 }} onClick={clearFilters}>Clear filters</Button>
                        ) : null}
                    </Paper>
                ) : (
                <Stack spacing={1.25}>
                    {rows.map((r) => {
                        const occ = occupancyForUnit(r.unit_number);
                        return (
                            <Paper
                                key={r.id}
                                sx={{ p: 1.5, cursor: 'pointer' }}
                                onClick={() => openDetail(r.id)}
                            >
                                <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <Box sx={{ minWidth: 0 }}>
                                        <Typography fontWeight={700}>{r.full_name || '—'}</Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            Flat {r.unit_number}
                                            {getResidentBlock(r.unit_number) ? ` · Block ${getResidentBlock(r.unit_number)}` : ''}
                                        </Typography>
                                    </Box>
                                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                                        <KindChip kind={r.kind} />
                                        <RowMenu
                                            resident={r}
                                            canEdit={canEdit}
                                            onView={(x) => openDetail(x.id)}
                                            onEdit={openEdit}
                                            onDeletePerson={(x) => setDeleteTarget({ type: 'person', resident: x })}
                                            onDeleteFlat={(x) => setDeleteTarget({
                                                type: 'flat',
                                                unit: x.unit_number,
                                                residents: occupancyForUnit(x.unit_number).mates,
                                            })}
                                        />
                                    </Stack>
                                </Stack>
                                <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
                                    {r.is_primary ? <Chip size="small" label="Primary" color="success" variant="outlined" /> : null}
                                    {r.is_residing === false ? <Chip size="small" label="Non-residing" /> : null}
                                    {occ.meta ? <Chip size="small" label={occ.meta.shortLabel || occ.meta.label} variant="outlined" /> : null}
                                </Stack>
                                {(r.phone || r.email) ? (
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                                        {[r.phone, r.email].filter(Boolean).join(' · ')}
                                    </Typography>
                                ) : null}
                            </Paper>
                        );
                    })}
                </Stack>
                )
            ) : (
                <TableContainer component={Paper}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                {RESIDENT_COLS.map((col) => (
                                    <TableCell key={col.key} sx={{ whiteSpace: 'nowrap' }}>{headerMenu(col)}</TableCell>
                                ))}
                                <TableCell align="right"> </TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={9}>
                                        <Typography color="text.secondary">
                                            {activeFiltersCount || listParams.search || Object.values(colFilter).some((v) => String(v).trim())
                                                ? 'No residents match these filters.'
                                                : 'No residents recorded yet.'}
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            ) : rows.map((r) => {
                                const occ = occupancyForUnit(r.unit_number);
                                return (
                                    <TableRow
                                        key={r.id}
                                        hover
                                        sx={{ cursor: 'pointer' }}
                                        onClick={() => openDetail(r.id)}
                                    >
                                        <TableCell>
                                            <Typography fontWeight={600}>{r.full_name || '—'}</Typography>
                                        </TableCell>
                                        <TableCell>{r.unit_number}</TableCell>
                                        <TableCell>{getResidentBlock(r.unit_number) || '—'}</TableCell>
                                        <TableCell><KindChip kind={r.kind} /></TableCell>
                                        <TableCell>
                                            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }} useFlexGap>
                                                {r.is_primary ? <Chip size="small" label="Primary" color="success" variant="outlined" /> : null}
                                                {r.is_residing === false ? <Chip size="small" label="Non-residing" /> : null}
                                            </Stack>
                                        </TableCell>
                                        <TableCell>
                                            {occ.meta ? (
                                                <Tooltip title={occ.meta.hint || ''}>
                                                    <Chip size="small" label={occ.meta.shortLabel || occ.meta.label} variant="outlined" />
                                                </Tooltip>
                                            ) : '—'}
                                        </TableCell>
                                        <TableCell>{r.phone || '—'}</TableCell>
                                        <TableCell>{r.email || '—'}</TableCell>
                                        <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                            <RowMenu
                                                resident={r}
                                                canEdit={canEdit}
                                                onView={(x) => openDetail(x.id)}
                                                onEdit={openEdit}
                                                onDeletePerson={(x) => setDeleteTarget({ type: 'person', resident: x })}
                                                onDeleteFlat={(x) => setDeleteTarget({
                                                    type: 'flat',
                                                    unit: x.unit_number,
                                                    residents: occupancyForUnit(x.unit_number).mates,
                                                })}
                                            />
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            {!isLoading && rows.length > 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    {rows.length} resident{rows.length === 1 ? '' : 's'}
                    {activeFiltersCount || listParams.search ? ' (filtered)' : ''}
                    {hiddenCount ? ` · ${hiddenCount} duplicate(s) hidden` : ''}
                </Typography>
            ) : null}

            <Dialog
                open={filterOpen}
                onClose={() => setFilterOpen(false)}
                fullWidth
                maxWidth="sm"
                scroll="paper"
                slotProps={{ paper: { sx: { maxHeight: '90vh' } } }}
            >
                <DialogTitle>Filters</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <FormControl fullWidth size="small">
                            <InputLabel>Kind</InputLabel>
                            <Select
                                label="Kind"
                                value={localFilters.kind}
                                onChange={(e) => setLocalFilters((p) => ({ ...p, kind: e.target.value }))}
                            >
                                <MenuItem value="">All</MenuItem>
                                <MenuItem value="OWNER">Owner</MenuItem>
                                <MenuItem value="TENANT">Tenant</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl fullWidth size="small">
                            <InputLabel>Residency</InputLabel>
                            <Select
                                label="Residency"
                                value={localFilters.residency}
                                onChange={(e) => setLocalFilters((p) => ({ ...p, residency: e.target.value }))}
                            >
                                <MenuItem value="">All</MenuItem>
                                <MenuItem value="residing">Residing</MenuItem>
                                <MenuItem value="non-residing">Non-residing</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl fullWidth size="small">
                            <InputLabel>Block</InputLabel>
                            <Select
                                label="Block"
                                value={localFilters.block}
                                onChange={(e) => setLocalFilters((p) => ({ ...p, block: e.target.value }))}
                            >
                                <MenuItem value="">All blocks</MenuItem>
                                {blocks.map((b) => (
                                    <MenuItem key={b} value={b}>{b}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControl fullWidth size="small">
                            <InputLabel>Occupancy</InputLabel>
                            <Select
                                label="Occupancy"
                                value={localFilters.occupancy}
                                onChange={(e) => setLocalFilters((p) => ({ ...p, occupancy: e.target.value }))}
                            >
                                {occupancyFilterOptions.map((opt) => (
                                    <MenuItem key={opt.value || 'all'} value={opt.value}>
                                        {opt.label}
                                        {opt.value && occupancyCounts ? (() => {
                                            const map = {
                                                OWNER_OCCUPIED: occupancyCounts.ownerOccupied,
                                                TENANT_OCCUPIED: occupancyCounts.tenantOccupied,
                                                VACANT: occupancyCounts.vacant,
                                                NON_ALLOTABLE: occupancyCounts.nonAllotable,
                                                no_owner: occupancyCounts.noOwnerFlats,
                                                UNDER_RENOVATION: occupancyCounts.underRenovation,
                                                LOCKED: occupancyCounts.locked,
                                                DEVELOPER_HOLD: occupancyCounts.developerHold,
                                            };
                                            const n = map[opt.value];
                                            return n != null ? ` (${n})` : '';
                                        })() : null}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControlLabel
                            control={(
                                <Checkbox
                                    checked={localFilters.primary === '1'}
                                    onChange={(e) => setLocalFilters((p) => ({
                                        ...p,
                                        primary: e.target.checked ? '1' : '',
                                    }))}
                                />
                            )}
                            label="Primary contacts only"
                        />
                        <Typography variant="caption" color="text.secondary">
                            {Object.entries(OCCUPANCY_SUMMARY)
                                .filter(([k]) => ['VACANT', 'NON_ALLOTABLE'].includes(k))
                                .map(([, m]) => m.hint)
                                .filter(Boolean)
                                .join(' ')}
                        </Typography>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={clearFilters}>Clear</Button>
                    <Button variant="contained" onClick={applyFilters}>Apply</Button>
                </DialogActions>
            </Dialog>

            <ResidentFormDialog
                open={formOpen}
                resident={editResident}
                onClose={() => setFormOpen(false)}
                onSaved={invalidate}
            />

            <ResidentImportDialog
                open={importOpen}
                onClose={() => setImportOpen(false)}
                onImported={invalidate}
            />

            <Dialog
                open={Boolean(deleteTarget)}
                onClose={() => setDeleteTarget(null)}
                fullWidth
                maxWidth="sm"
            >
                <DialogTitle>
                    {deleteTarget?.type === 'flat' ? 'Delete flat?' : 'Delete resident?'}
                </DialogTitle>
                <DialogContent>
                    <Typography whiteSpace="pre-wrap">
                        {deleteTarget?.type === 'flat'
                            ? flatDeleteConfirmMessage(deleteTarget.unit, deleteTarget.residents || [])
                            : `Delete resident record for ${deleteTarget?.resident?.full_name || 'this person'}?`}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={confirmDelete}>Delete</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
