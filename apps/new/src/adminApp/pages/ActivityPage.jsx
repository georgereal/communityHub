import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    Alert, Autocomplete, Box, Chip, CircularProgress, IconButton, Stack, Tab, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Tabs, Paper, TextField, Tooltip, Typography,
} from '@mui/material';
import { History as HistoryIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import {
    activityActionLabel,
    activityEntityLabel,
    fetchActivityEvents,
} from '../../activityAudit.js';
import { fetchPassbookJobs } from '../../passbookEvolyx.js';
import { fetchSpreadsheetRuns } from '../../spreadsheetSyncApi.js';
import { portalState } from '../../store.js';

const TABS = [
    { key: 'all', label: 'All activity' },
    { key: 'passbook', label: 'Passbook OCR' },
    { key: 'spreadsheet', label: 'Spreadsheet sync' },
];

function fmtWhen(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}

function statusChip(status) {
    const s = String(status || '').toUpperCase();
    const color = s === 'OK' || s === 'SUCCEEDED' || s === 'IMPORTED' || s === 'APPROVED'
        ? 'success'
        : s === 'FAILED' || s === 'ERROR' || s === 'REJECTED'
            ? 'error'
            : s === 'WARN' || s === 'PENDING' || s === 'RUNNING'
                ? 'warning'
                : 'default';
    return <Chip size="small" label={status || '—'} color={color} variant={color === 'default' ? 'outlined' : 'filled'} />;
}

function AllActivityTab({ entityFilter, actionFilter, onEntityFilter, onActionFilter }) {
    const apartmentId = portalState.access?.activeApartmentId;
    const q = useQuery({
        queryKey: ['admin-activity-events', apartmentId, entityFilter, actionFilter],
        enabled: Boolean(apartmentId),
        queryFn: () => fetchActivityEvents(apartmentId, {
            entityType: entityFilter || '',
            action: actionFilter || '',
            limit: 500,
        }),
    });

    const byEntity = q.data?.counts?.by_entity || {};
    const facetEntities = q.data?.facets?.entity_types || Object.keys(byEntity);
    const facetActions = q.data?.facets?.actions || [];

    const entityOptions = useMemo(
        () => facetEntities.map((value) => ({
            value,
            label: `${activityEntityLabel(value)}${byEntity[value] != null ? ` (${byEntity[value]})` : ''}`,
        })),
        [facetEntities, byEntity],
    );

    const actionOptions = useMemo(
        () => facetActions.map((value) => ({
            value,
            label: activityActionLabel(value),
        })),
        [facetActions],
    );

    const summaryCards = useMemo(() => {
        const cards = [
            { key: '', label: 'All functions', value: q.data?.counts?.total ?? '—', tone: 'default' },
        ];
        // Cards from live counts only (includes PARKING from vehicle_audit_log)
        const entries = Object.entries(byEntity).sort((a, b) => b[1] - a[1]);
        for (const [value, n] of entries) {
            cards.push({
                key: value,
                label: activityEntityLabel(value),
                value: n,
                tone: value === 'PARKING' ? 'tenant' : 'owner',
            });
        }
        return cards;
    }, [byEntity, q.data?.counts?.total]);

    const selectedEntity = entityOptions.find((o) => o.value === entityFilter) || null;
    const selectedAction = actionOptions.find((o) => o.value === actionFilter) || null;
    const meta = q.data?.meta || {};
    const counts = q.data?.counts || {};

    return (
        <Box>
            <SummaryStrip
                cards={summaryCards}
                activeKey={entityFilter || ''}
                onSelect={(key) => onEntityFilter(key || '')}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, mt: 1, flexWrap: 'wrap' }}>
                <Autocomplete
                    size="small"
                    sx={{ minWidth: 260, flex: 1 }}
                    options={entityOptions}
                    value={selectedEntity}
                    onChange={(_e, opt) => onEntityFilter(opt?.value || '')}
                    getOptionLabel={(o) => o?.label || ''}
                    isOptionEqualToValue={(a, b) => a?.value === b?.value}
                    renderInput={(params) => (
                        <TextField {...params} label="Functionality" placeholder="Type to filter…" />
                    )}
                />
                <Autocomplete
                    size="small"
                    sx={{ minWidth: 200 }}
                    options={actionOptions}
                    value={selectedAction}
                    onChange={(_e, opt) => onActionFilter(opt?.value || '')}
                    getOptionLabel={(o) => o?.label || ''}
                    isOptionEqualToValue={(a, b) => a?.value === b?.value}
                    renderInput={(params) => (
                        <TextField {...params} label="Action" placeholder="Type to filter…" />
                    )}
                />
            </Stack>

            {!q.isLoading && !q.isError && q.data?.outbox?.pending > 0 ? (
                <Alert severity="warning" sx={{ mb: 2 }}>
                    {q.data.outbox.pending} audit event(s) are queued on this device after a network/API
                    failure and will retry automatically when online.
                </Alert>
            ) : null}
            {!q.isLoading && !q.isError ? (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
                    Showing {q.data?.events?.length || 0} of {counts.total ?? 0} events
                    {counts.parking != null ? ` · parking ${counts.parking}` : ''}
                    {counts.activity != null ? ` · other ${counts.activity}` : ''}
                    {meta.window_oldest || meta.window_newest
                        ? ` · window ${fmtWhen(meta.window_oldest)} → ${fmtWhen(meta.window_newest)}`
                        : ''}
                    . Sources: activity_audit_log + vehicle_audit_log.
                </Typography>
            ) : null}

            {q.isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}><CircularProgress /></Box>
            ) : q.isError ? (
                <Alert severity="error">{q.error?.message || 'Failed to load activity.'}</Alert>
            ) : !(q.data?.events || []).length ? (
                <Alert severity="info">No activity yet for this filter.</Alert>
            ) : (
                <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>When</TableCell>
                                <TableCell>Functionality</TableCell>
                                <TableCell>Action</TableCell>
                                <TableCell>Actor</TableCell>
                                <TableCell>Summary</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(q.data.events || []).map((row) => (
                                <TableRow key={`${row.source || 'a'}-${row.id}`} hover>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtWhen(row.created_at)}</TableCell>
                                    <TableCell>
                                        <Chip size="small" variant="outlined" label={activityEntityLabel(row.entity_type)} />
                                    </TableCell>
                                    <TableCell>{activityActionLabel(row.action)}</TableCell>
                                    <TableCell>{row.actor_label || '—'}</TableCell>
                                    <TableCell>
                                        <Typography variant="body2">{row.summary || '—'}</Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {row.entity_type}/{row.entity_id}
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </Box>
    );
}

function PassbookTab() {
    const apartmentId = portalState.access?.activeApartmentId;
    const q = useQuery({
        queryKey: ['admin-activity-passbook', apartmentId],
        enabled: Boolean(apartmentId),
        queryFn: () => fetchPassbookJobs(apartmentId),
    });
    const jobs = q.data || [];
    const failed = jobs.filter((j) => /fail|error/i.test(String(j.status || ''))).length;

    return (
        <Box>
            <SummaryStrip
                cards={[
                    { key: 'all', label: 'Jobs', value: jobs.length, tone: 'default' },
                    { key: 'failed', label: 'Failed', value: failed, tone: 'tenant' },
                ]}
                activeKey="all"
            />
            {q.isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}><CircularProgress /></Box>
            ) : q.isError ? (
                <Alert severity="error">{q.error?.message || 'Failed to load passbook jobs.'}</Alert>
            ) : !jobs.length ? (
                <Alert severity="info" sx={{ mt: 2 }}>No passbook OCR jobs yet.</Alert>
            ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ mt: 2 }}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>When</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell>Files</TableCell>
                                <TableCell>Mapped / imported</TableCell>
                                <TableCell>Message</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {jobs.map((job) => (
                                <TableRow key={job.id} hover>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtWhen(job.created_at || job.updated_at)}</TableCell>
                                    <TableCell>{statusChip(job.status)}</TableCell>
                                    <TableCell>{job.file_count ?? job.files?.length ?? '—'}</TableCell>
                                    <TableCell>
                                        {(job.mapped_count ?? job.line_count ?? '—')}
                                        {job.import_count != null ? ` / ${job.import_count}` : ''}
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 360 }}>
                                            {job.error_message || job.message || job.execution_id || '—'}
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </Box>
    );
}

function SpreadsheetTab() {
    const apartmentId = portalState.access?.activeApartmentId;
    const q = useQuery({
        queryKey: ['admin-activity-spreadsheet-runs', apartmentId],
        enabled: Boolean(apartmentId),
        queryFn: () => fetchSpreadsheetRuns(apartmentId),
    });
    const runs = q.data?.runs || [];
    const counts = q.data?.counts || {};

    return (
        <Box>
            <SummaryStrip
                cards={[
                    { key: 'all', label: 'Runs', value: counts.total ?? runs.length, tone: 'default' },
                    { key: 'ok', label: 'OK', value: counts.ok ?? 0, tone: 'owner' },
                    { key: 'failed', label: 'Failed', value: counts.failed ?? 0, tone: 'tenant' },
                ]}
                activeKey="all"
            />
            {q.isLoading ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}><CircularProgress /></Box>
            ) : q.isError ? (
                <Alert severity="error">{q.error?.message || 'Failed to load spreadsheet runs.'}</Alert>
            ) : !runs.length ? (
                <Alert severity="info" sx={{ mt: 2 }}>No spreadsheet sync runs yet.</Alert>
            ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ mt: 2 }}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>Started</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell>In / Up / Del / Push</TableCell>
                                <TableCell>Message</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {runs.map((run) => (
                                <TableRow key={run.id} hover>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtWhen(run.started_at)}</TableCell>
                                    <TableCell>{statusChip(run.status)}</TableCell>
                                    <TableCell>
                                        {run.imported}/{run.updated}/{run.deleted}/{run.pushed}
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 400 }}>
                                            {run.message || '—'}
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </Box>
    );
}

export default function ActivityPage() {
    const qc = useQueryClient();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'all';
    const entityFilter = params.get('entity') || '';
    const actionFilter = params.get('action') || '';
    const [error, setError] = useState('');

    const setTab = (next) => {
        const nextParams = new URLSearchParams(params);
        nextParams.set('tab', next);
        if (next !== 'all') {
            nextParams.delete('entity');
            nextParams.delete('action');
        }
        setParams(nextParams, { replace: true });
    };

    const setEntityFilter = (entity) => {
        const nextParams = new URLSearchParams(params);
        nextParams.set('tab', 'all');
        if (entity) nextParams.set('entity', entity);
        else nextParams.delete('entity');
        setParams(nextParams, { replace: true });
    };

    const setActionFilter = (action) => {
        const nextParams = new URLSearchParams(params);
        nextParams.set('tab', 'all');
        if (action) nextParams.set('action', action);
        else nextParams.delete('action');
        setParams(nextParams, { replace: true });
    };

    const refresh = () => {
        setError('');
        qc.invalidateQueries({ queryKey: ['admin-activity-events'] });
        qc.invalidateQueries({ queryKey: ['admin-activity-passbook'] });
        qc.invalidateQueries({ queryKey: ['admin-activity-spreadsheet-runs'] });
    };

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Activity"
                subtitle="Consolidated audit trail (society activity + parking vehicle changes) and integration job runs. Type in Functionality to filter by what exists in your data."
                actions={(
                    <Tooltip title="Refresh">
                        <IconButton size="small" onClick={refresh} aria-label="Refresh">
                            <RefreshIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>
                )}
            />

            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}

            <Tabs
                value={tab}
                onChange={(_e, v) => setTab(v)}
                sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
            >
                {TABS.map((t) => (
                    <Tab
                        key={t.key}
                        value={t.key}
                        label={t.label}
                        icon={t.key === 'all' ? <HistoryIcon fontSize="small" /> : undefined}
                        iconPosition="start"
                    />
                ))}
            </Tabs>

            {tab === 'all' ? (
                <AllActivityTab
                    entityFilter={entityFilter}
                    actionFilter={actionFilter}
                    onEntityFilter={setEntityFilter}
                    onActionFilter={setActionFilter}
                />
            ) : null}
            {tab === 'passbook' ? <PassbookTab /> : null}
            {tab === 'spreadsheet' ? <SpreadsheetTab /> : null}

            {tab === 'all' ? (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
                    Tip: open Integrations → spreadsheet sync → View spreadsheet runs, or{' '}
                    <Box
                        component="button"
                        type="button"
                        onClick={() => navigate('/activity?tab=spreadsheet')}
                        sx={{
                            border: 0, background: 'none', color: 'primary.main', cursor: 'pointer',
                            p: 0, font: 'inherit', textDecoration: 'underline',
                        }}
                    >
                        jump to spreadsheet runs
                    </Box>
                    .
                </Typography>
            ) : null}
        </Box>
    );
}
