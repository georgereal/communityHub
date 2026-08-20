import React, { useState } from 'react';
import {
    Alert, Box, Button, Checkbox, CircularProgress, IconButton, Paper,
    Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { Refresh as RefreshIcon, Save as SaveIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import SummaryStrip from '../components/SummaryStrip.jsx';
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
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const q = useQuery({
        queryKey: ['admin-roles'],
        queryFn: loadRbacMatrix,
    });

    const state = draft || q.data;
    const roles = state?.roles || [];
    const resources = state?.resources || [];

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

    const save = async () => {
        if (!state) return;
        setError('');
        setSaving(true);
        try {
            await saveRbacEditor({ crud: state.crud });
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

    const cards = [
        { key: 'roles', label: 'Roles', value: roles.length, tone: 'default' },
        { key: 'resources', label: 'Resources', value: resources.length, tone: 'owner' },
        { key: 'delete', label: 'Delete grants', value: deleteGrants, tone: deleteGrants ? 'warn' : 'tenant' },
    ];

    return (
        <Box className="residents-react-page admin-app-page admin-app-page--wide">
            <PageHeader
                title="Roles"
                subtitle="One CRUD grid per role. Pages and nav follow Read; buttons follow Create / Update / Delete. Turn whole modules off in Society profile."
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
                        {canEdit ? (
                            <Button
                                variant="contained"
                                size="small"
                                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                                disabled={saving || !draft}
                                onClick={save}
                            >
                                Save
                            </Button>
                        ) : null}
                    </>
                )}
            />
            <SummaryStrip cards={cards} activeKey="resources" />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
            {!canEdit ? (
                <Alert severity="info" sx={{ mb: 2 }}>Only a Society Administrator can change role CRUD.</Alert>
            ) : null}

            {q.isLoading || !state ? (
                <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
            ) : (
                <>
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
                                                    disabled={!canEdit}
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
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                        C = Create, R = Read, U = Update, D = Delete. Read shows the screens. Create/Update/Delete are the buttons. D is off until you tick it (Finance trash, delete unit, etc.).
                    </Typography>
                </>
            )}
        </Box>
    );
}
