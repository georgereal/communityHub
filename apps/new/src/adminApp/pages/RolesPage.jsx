import React, { useState } from 'react';
import {
    Alert, Box, Button, Checkbox, CircularProgress, IconButton, Paper,
    Tab, Tabs,
    Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { Refresh as RefreshIcon, Save as SaveIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
import CapGate from '../../components/CapGate.jsx';
import { can } from '../../capabilities.js';
import { loadRbacMatrix, saveRbacEditor, v2KeyToLabel } from '../api.js';
import { CRUD_ACTIONS } from '../../rbacMatrix.js';

function cloneMatrix(state) {
    return JSON.parse(JSON.stringify(state));
}

export default function RolesPage() {
    const qc = useQueryClient();
    const canEdit = can('admin.roles.edit');
    const [draft, setDraft] = useState(null);
    const [tab, setTab] = useState('pages');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const q = useQuery({
        queryKey: ['admin-roles'],
        queryFn: loadRbacMatrix,
    });

    const state = draft || q.data;
    const roles = state?.roles || [];
    const resources = state?.resources || [];
    const pageGroups = state?.pageGroups || [];

    const setCrud = (role, resource, action, on) => {
        setDraft((prev) => {
            const next = cloneMatrix(prev || q.data);
            const row = { ...(next.crud[role][resource] || {}) };
            row[action] = on;
            if (on && action !== 'read') row.read = true;
            if (!on && action === 'read') {
                row.create = false;
                row.update = false;
                row.delete = false;
            }
            next.crud[role][resource] = row;
            return next;
        });
    };

    const setPage = (role, route, on) => {
        setDraft((prev) => {
            const next = cloneMatrix(prev || q.data);
            next.pages[role] = next.pages[role] || {};
            next.pages[role][route] = on;
            return next;
        });
    };

    const save = async () => {
        if (!state) return;
        setError('');
        setSaving(true);
        try {
            await saveRbacEditor({
                crud: state.crud,
                pages: state.pages,
                moduleEnabled: state.moduleEnabled,
            });
            setDraft(null);
            await qc.invalidateQueries({ queryKey: ['admin-roles'] });
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const deleteGrants = roles.reduce((n, role) => (
        n + resources.filter((res) => state?.crud?.[role]?.[res.key]?.delete).length
    ), 0);

    const pageDenials = roles.reduce((n, role) => (
        n + pageGroups.reduce((m, group) => (
            m + group.pages.filter((page) => state?.pages?.[role]?.[page.route] === false).length
        ), 0)
    ), 0);

    const cards = [
        { key: 'roles', label: 'Roles', value: roles.length, tone: 'default' },
        { key: 'pages', label: 'Page denials', value: pageDenials, tone: pageDenials ? 'warn' : 'default' },
        { key: 'delete', label: 'Delete grants', value: deleteGrants, tone: deleteGrants ? 'warn' : 'tenant' },
    ];

    return (
        <Box className="residents-react-page admin-app-page admin-app-page--wide">
            <PageHeader
                title="Roles"
                subtitle="Pages control which screens appear in the nav. CRUD controls buttons and API writes (Create / Read / Update / Delete)."
                actions={(
                    <>
                        <Tooltip title="Refresh">
                            <IconButton
                                size="small"
                                onClick={() => { setDraft(null); qc.invalidateQueries({ queryKey: ['admin-roles'] }); }}
                            >
                                {q.isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                        <CapGate cap="admin.roles.edit">
                            <Button
                                variant="contained"
                                size="small"
                                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                                disabled={saving || !draft}
                                onClick={save}
                            >
                                Save
                            </Button>
                        </CapGate>
                    </>
                )}
            />
            <SummaryStrip cards={cards} activeKey={tab === 'pages' ? 'pages' : 'delete'} />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {!canEdit ? (
                <Alert severity="info" sx={{ mb: 2 }}>Only a Society Administrator can change role access.</Alert>
            ) : null}

            <Tabs value={tab} onChange={(_e, next) => setTab(next)} sx={{ mb: 2 }}>
                <Tab value="pages" label="Pages" />
                <Tab value="crud" label="CRUD (buttons)" />
            </Tabs>

            {tab === 'pages' ? (
                <Alert severity="info" sx={{ mb: 2 }}>
                    Uncheck a page to hide it for that role (even when Read is on in CRUD). Users still need the role&apos;s permission keys — this only narrows which routes appear.
                </Alert>
            ) : (
                <Alert severity="info" sx={{ mb: 2 }}>
                    Read opens data on allowed pages. Create / Update / Delete control action buttons (Quick capture uses Create on Finance).
                </Alert>
            )}

            {q.isLoading || !state ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : tab === 'crud' ? (
                <>
                    <CapGate cap="admin.roles.edit" mode="disable">
                    <TableContainer component={Paper} sx={{ maxHeight: '70vh', overflowX: 'auto' }}>
                        <Table size="small" stickyHeader>
                            <TableHead>
                                <TableRow>
                                    <TableCell rowSpan={2} sx={{ position: 'sticky', left: 0, zIndex: 3, bgcolor: 'background.paper' }}>Resource</TableCell>
                                    {roles.map((role) => (
                                        <TableCell key={role} align="center" colSpan={CRUD_ACTIONS.length} sx={{ fontSize: '0.7rem' }}>
                                            {v2KeyToLabel(role)}
                                        </TableCell>
                                    ))}
                                </TableRow>
                                <TableRow>
                                    {roles.flatMap((role) => CRUD_ACTIONS.map((a) => (
                                        <TableCell key={`${role}-${a.key}`} align="center" sx={{ fontSize: '0.65rem' }} title={a.label}>
                                            {a.short}
                                        </TableCell>
                                    )))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {resources.map((res) => (
                                    <TableRow key={res.key} hover>
                                        <TableCell sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper' }}>
                                            {res.label}
                                            <Typography variant="caption" display="block" color="text.secondary">{res.key}</Typography>
                                        </TableCell>
                                        {roles.flatMap((role) => CRUD_ACTIONS.map((a) => (
                                            <TableCell key={`${role}-${res.key}-${a.key}`} align="center" padding="checkbox">
                                                <Checkbox
                                                    size="small"
                                                    checked={!!state.crud[role]?.[res.key]?.[a.key]}
                                                    onChange={(e) => setCrud(role, res.key, a.key, e.target.checked)}
                                                />
                                            </TableCell>
                                        )))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                    </CapGate>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                        C = Create, R = Read, U = Update, D = Delete.
                    </Typography>
                </>
            ) : (
                <CapGate cap="admin.roles.edit" mode="disable">
                <TableContainer component={Paper} sx={{ maxHeight: '70vh', overflowX: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell sx={{ position: 'sticky', left: 0, zIndex: 3, bgcolor: 'background.paper' }}>Page</TableCell>
                                {roles.map((role) => (
                                    <TableCell key={role} align="center" sx={{ fontSize: '0.7rem', minWidth: 72 }}>
                                        {v2KeyToLabel(role)}
                                    </TableCell>
                                ))}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {pageGroups.map((group) => (
                                <React.Fragment key={group.moduleId}>
                                    <TableRow>
                                        <TableCell
                                            colSpan={roles.length + 1}
                                            sx={{ bgcolor: 'action.hover', fontWeight: 700, fontSize: '0.75rem' }}
                                        >
                                            {group.moduleLabel}
                                        </TableCell>
                                    </TableRow>
                                    {group.pages.map((page) => (
                                        <TableRow key={page.route} hover>
                                            <TableCell sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper' }}>
                                                {page.label}
                                                <Typography variant="caption" display="block" color="text.secondary">{page.route}</Typography>
                                            </TableCell>
                                            {roles.map((role) => {
                                                const allowed = state.pages?.[role]?.[page.route] !== false;
                                                return (
                                                    <TableCell key={`${role}-${page.route}`} align="center" padding="checkbox">
                                                        <Checkbox
                                                            size="small"
                                                            checked={allowed}
                                                            onChange={(e) => setPage(role, page.route, e.target.checked)}
                                                            inputProps={{ 'aria-label': `${page.label} for ${v2KeyToLabel(role)}` }}
                                                        />
                                                    </TableCell>
                                                );
                                            })}
                                        </TableRow>
                                    ))}
                                </React.Fragment>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
                </CapGate>
            )}
        </Box>
    );
}
