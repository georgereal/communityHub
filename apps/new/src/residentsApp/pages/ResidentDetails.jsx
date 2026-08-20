import React, { useMemo, useState } from 'react';
import {
    Alert,
    Avatar,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    Menu,
    MenuItem,
    Paper,
    Stack,
    Tab,
    Tabs,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography,
    useMediaQuery,
    useTheme,
} from '@mui/material';
import {
    ArrowBack as ArrowBackIcon,
    Delete as DeleteIcon,
    Edit as EditIcon,
    Email as EmailIcon,
    Home as HomeIcon,
    MoreVert as MoreVertIcon,
    Phone as PhoneIcon,
    Group as GroupIcon,
    Dashboard as OverviewIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { navigateBackToList, navigateToDetail } from '../utils/listNavigation.js';
import ResidentFormDialog from '../components/ResidentFormDialog.jsx';
import {
    canEditResidents,
    deleteFlat,
    deleteResident,
    fetchResidentsBundle,
    flatDeleteConfirmMessage,
    getResidentById,
    getResidentBlock,
    getUnitMates,
    occupancyForUnit,
} from '../api.js';
import { portalState } from '../../store.js';

const tabSx = {
    textTransform: 'none',
    fontWeight: 600,
    minHeight: 40,
    fontSize: { xs: '0.78rem', sm: '0.8125rem' },
};

const panelSx = {
    p: { xs: 1.25, sm: 1.5 },
    borderRadius: 2,
    bgcolor: '#fff',
};

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (parts[0] || '?').slice(0, 2).toUpperCase();
}

export default function ResidentDetails() {
    const { residentId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const queryClient = useQueryClient();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const canEdit = canEditResidents();

    const tab = searchParams.get('tab') || 'overview';
    const setTab = (next) => {
        const sp = new URLSearchParams(searchParams);
        if (!next || next === 'overview') sp.delete('tab');
        else sp.set('tab', next);
        setSearchParams(sp, { replace: true });
    };

    const [editOpen, setEditOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteFlatOpen, setDeleteFlatOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState('');
    const [actionsEl, setActionsEl] = useState(null);

    const { isLoading, error, dataUpdatedAt } = useQuery({
        queryKey: ['residents-bundle', portalState.access?.activeApartmentId],
        queryFn: fetchResidentsBundle,
        staleTime: 30_000,
    });

    const resident = useMemo(
        () => (dataUpdatedAt ? getResidentById(residentId) : null),
        [dataUpdatedAt, residentId],
    );

    const mates = useMemo(
        () => (resident ? getUnitMates(resident.unit_number, resident.id) : []),
        [resident],
    );

    const occ = useMemo(
        () => (resident ? occupancyForUnit(resident.unit_number) : null),
        [resident],
    );

    const unit = useMemo(() => {
        if (!resident) return null;
        const n = String(resident.unit_number || '').trim().toUpperCase();
        return (portalState.units || []).find(
            (u) => String(u.number || '').trim().toUpperCase() === n,
        ) || null;
    }, [resident]);

    const goBack = () => navigateBackToList(navigate, location, '/');

    const handleDelete = async () => {
        if (!resident) return;
        setBusy(true);
        setActionError('');
        try {
            await deleteResident(resident.id);
            await queryClient.invalidateQueries({ queryKey: ['residents-bundle'] });
            goBack();
        } catch (err) {
            setActionError(err?.message || 'Delete failed.');
        } finally {
            setBusy(false);
            setDeleteOpen(false);
        }
    };

    const handleDeleteFlat = async () => {
        if (!resident) return;
        setBusy(true);
        setActionError('');
        try {
            await deleteFlat(resident.unit_number);
            await queryClient.invalidateQueries({ queryKey: ['residents-bundle'] });
            goBack();
        } catch (err) {
            setActionError(err?.message || 'Could not delete flat.');
        } finally {
            setBusy(false);
            setDeleteFlatOpen(false);
        }
    };

    if (isLoading) {
        return (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
                <CircularProgress />
            </Box>
        );
    }

    if (error) {
        return <Alert severity="error">{error.message || 'Failed to load.'}</Alert>;
    }

    if (!resident) {
        return (
            <Box>
                <Button startIcon={<ArrowBackIcon />} onClick={goBack} sx={{ mb: 2 }}>Back</Button>
                <Alert severity="warning">Resident not found.</Alert>
            </Box>
        );
    }

    const kind = String(resident.kind || 'OWNER').toUpperCase();

    return (
        <Box className="residents-react-page">
            <Stack direction="row" sx={{ mb: 2, gap: 1, alignItems: 'center' }}>
                <IconButton onClick={goBack} aria-label="Back to list">
                    <ArrowBackIcon />
                </IconButton>
                <Typography variant="body2" color="text.secondary">Residents</Typography>
            </Stack>

            <Paper sx={{ ...panelSx, mb: 2 }}>
                <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
                        <Avatar sx={{ width: { xs: 44, sm: 56 }, height: { xs: 44, sm: 56 }, bgcolor: 'primary.main', fontWeight: 700 }}>
                            {initials(resident.full_name)}
                        </Avatar>
                        <Box sx={{ minWidth: 0 }}>
                            <Typography
                                variant={isMobile ? 'subtitle1' : 'h5'}
                                component="h1"
                                fontWeight={700}
                                noWrap
                            >
                                {resident.full_name || '—'}
                            </Typography>
                            <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 0.75, flexWrap: 'wrap' }}>
                                <Chip
                                    size="small"
                                    icon={<HomeIcon />}
                                    label={`Flat ${resident.unit_number}`}
                                />
                                {getResidentBlock(resident.unit_number) ? (
                                    <Chip size="small" label={`Block ${getResidentBlock(resident.unit_number)}`} variant="outlined" />
                                ) : null}
                                <Chip
                                    size="small"
                                    label={kind === 'TENANT' ? 'Tenant' : 'Owner'}
                                    color={kind === 'TENANT' ? 'info' : 'default'}
                                />
                                {resident.is_primary ? <Chip size="small" color="success" label="Primary" variant="outlined" /> : null}
                                {resident.is_residing === false ? <Chip size="small" label="Non-residing" /> : null}
                                {occ?.meta ? <Chip size="small" label={occ.meta.shortLabel || occ.meta.label} /> : null}
                            </Stack>
                        </Box>
                    </Stack>
                    {canEdit && isMobile ? (
                        <>
                            <IconButton
                                aria-label="Resident actions"
                                onClick={(e) => setActionsEl(e.currentTarget)}
                                sx={{ alignSelf: 'flex-start' }}
                            >
                                <MoreVertIcon />
                            </IconButton>
                            <Menu anchorEl={actionsEl} open={Boolean(actionsEl)} onClose={() => setActionsEl(null)}>
                                <MenuItem onClick={() => { setActionsEl(null); setEditOpen(true); }}>Edit</MenuItem>
                                <MenuItem onClick={() => { setActionsEl(null); setDeleteOpen(true); }}>Delete</MenuItem>
                                <MenuItem onClick={() => { setActionsEl(null); setDeleteFlatOpen(true); }}>Delete flat…</MenuItem>
                            </Menu>
                        </>
                    ) : null}
                    {canEdit && !isMobile ? (
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditOpen(true)}>
                                Edit
                            </Button>
                            <Button color="error" variant="outlined" startIcon={<DeleteIcon />} onClick={() => setDeleteOpen(true)}>
                                Delete
                            </Button>
                            <Button color="error" variant="text" onClick={() => setDeleteFlatOpen(true)}>
                                Delete flat…
                            </Button>
                        </Stack>
                    ) : null}
                </Stack>
            </Paper>

            {actionError ? <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert> : null}

            <Tabs
                value={tab}
                onChange={(_, v) => setTab(v)}
                variant="scrollable"
                allowScrollButtonsMobile
                sx={{ mb: 1.5, minHeight: 40, borderBottom: 1, borderColor: 'divider' }}
            >
                <Tab value="overview" label="Overview" icon={<OverviewIcon />} iconPosition="start" sx={tabSx} />
                <Tab value="unit" label="Unit mates" icon={<GroupIcon />} iconPosition="start" sx={tabSx} />
            </Tabs>

            {tab === 'overview' ? (
                <Stack spacing={2}>
                    <Paper sx={panelSx}>
                        <Typography fontWeight={700} sx={{ mb: 1.25 }}>Contact</Typography>
                        <Stack spacing={1.25}>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                <PhoneIcon fontSize="small" color="action" />
                                <Typography>{resident.phone || '—'}</Typography>
                            </Stack>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                <EmailIcon fontSize="small" color="action" />
                                <Typography>{resident.email || '—'}</Typography>
                            </Stack>
                        </Stack>
                        {resident.notes ? (
                            <>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography fontWeight={700} sx={{ mb: 0.75 }}>Notes</Typography>
                                <Typography variant="body2" color="text.secondary" whiteSpace="pre-wrap">
                                    {resident.notes}
                                </Typography>
                            </>
                        ) : null}
                    </Paper>

                    <Paper sx={panelSx}>
                        <Typography fontWeight={700} sx={{ mb: 1.25 }}>Unit</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                            {occ?.meta?.hint || 'Flat occupancy based on owners and tenants on record.'}
                        </Typography>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Chip label={`Flat ${resident.unit_number}`} />
                            {unit?.id ? <Chip variant="outlined" label={`Unit id ${unit.id}`} /> : null}
                            {occ?.meta ? <Chip color="primary" variant="outlined" label={occ.meta.label} /> : null}
                        </Stack>
                        <Button
                            sx={{ mt: 1.5 }}
                            size="small"
                            onClick={() => setTab('unit')}
                        >
                            View people in this flat ({mates.length + 1})
                        </Button>
                    </Paper>
                </Stack>
            ) : null}

            {tab === 'unit' ? (
                <Paper sx={panelSx}>
                    <Typography fontWeight={700} sx={{ mb: 1.25 }}>
                        People in flat {resident.unit_number}
                    </Typography>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Name</TableCell>
                                    <TableCell>Kind</TableCell>
                                    <TableCell>Flags</TableCell>
                                    <TableCell>Phone</TableCell>
                                    <TableCell> </TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                <TableRow selected>
                                    <TableCell>
                                        <Typography fontWeight={600}>{resident.full_name}</Typography>
                                        <Typography variant="caption" color="text.secondary">This profile</Typography>
                                    </TableCell>
                                    <TableCell>{kind === 'TENANT' ? 'Tenant' : 'Owner'}</TableCell>
                                    <TableCell>
                                        {resident.is_primary ? 'Primary' : '—'}
                                        {resident.is_residing === false ? ' · Non-residing' : ''}
                                    </TableCell>
                                    <TableCell>{resident.phone || '—'}</TableCell>
                                    <TableCell> </TableCell>
                                </TableRow>
                                {mates.map((m) => (
                                    <TableRow
                                        key={m.id}
                                        hover
                                        sx={{ cursor: 'pointer' }}
                                        onClick={() => navigateToDetail(navigate, location, `/${m.id}`)}
                                    >
                                        <TableCell>{m.full_name || '—'}</TableCell>
                                        <TableCell>
                                            {String(m.kind || '').toUpperCase() === 'TENANT' ? 'Tenant' : 'Owner'}
                                        </TableCell>
                                        <TableCell>
                                            {m.is_primary ? 'Primary' : '—'}
                                            {m.is_residing === false ? ' · Non-residing' : ''}
                                        </TableCell>
                                        <TableCell>{m.phone || '—'}</TableCell>
                                        <TableCell>
                                            <Button size="small">Open</Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                                {!mates.length ? (
                                    <TableRow>
                                        <TableCell colSpan={5}>
                                            <Typography variant="body2" color="text.secondary">
                                                No other residents recorded for this flat.
                                            </Typography>
                                        </TableCell>
                                    </TableRow>
                                ) : null}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            ) : null}

            <ResidentFormDialog
                open={editOpen}
                resident={resident}
                onClose={() => setEditOpen(false)}
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['residents-bundle'] })}
            />

            <Dialog open={deleteOpen} onClose={busy ? undefined : () => setDeleteOpen(false)}>
                <DialogTitle>Delete resident?</DialogTitle>
                <DialogContent>
                    <Typography>
                        Remove <strong>{resident.full_name}</strong> from flat {resident.unit_number}? This cannot be undone.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteOpen(false)} disabled={busy}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={handleDelete} disabled={busy}>
                        {busy ? 'Deleting…' : 'Delete'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={deleteFlatOpen} onClose={busy ? undefined : () => setDeleteFlatOpen(false)}>
                <DialogTitle>Delete flat?</DialogTitle>
                <DialogContent>
                    <Typography whiteSpace="pre-wrap">
                        {flatDeleteConfirmMessage(resident.unit_number, occ?.mates || [])}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteFlatOpen(false)} disabled={busy}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={handleDeleteFlat} disabled={busy}>
                        {busy ? 'Deleting…' : 'Delete flat'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
