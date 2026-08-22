import React, { useState } from 'react';
import {
    Alert, Box, Button, CircularProgress, FormControlLabel, Paper, Stack,
    Switch, TextField, Typography,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../components/PageHeader.jsx';
import CapGate from '../../components/CapGate.jsx';
import {
    loadModuleSettings, LOCKED_MODULE_KEYS, MODULE_CATALOG,
    saveModules, saveSocietyProfile, societyProfile,
} from '../api.js';
import BankSection from './BankPage.jsx';

export default function SocietyPage() {
    const qc = useQueryClient();
    const initial = societyProfile();
    const [name, setName] = useState(initial.name);
    const [car, setCar] = useState(initial.car_default);
    const [bike, setBike] = useState(initial.bike_default);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const modulesQ = useQuery({
        queryKey: ['admin-modules'],
        queryFn: loadModuleSettings,
    });
    const [toggles, setToggles] = useState(null);
    const settings = toggles || modulesQ.data || {};

    const saveProfile = async () => {
        setError('');
        setSaving(true);
        try {
            await saveSocietyProfile({
                name: name.trim(),
                car_default: Number(car) || 0,
                bike_default: Number(bike) || 0,
            });
            qc.invalidateQueries();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const saveMods = async () => {
        setError('');
        setSaving(true);
        try {
            await saveModules(settings);
            await modulesQ.refetch();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Box className="residents-react-page admin-app-page">
            <PageHeader
                title="Society profile"
                subtitle="Identity, bank account, default parking, and which modules staff can see."
                actions={(
                    <CapGate cap="admin.society.save">
                        <Button variant="contained" size="small" startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />} onClick={saveProfile} disabled={saving}>
                            Save
                        </Button>
                    </CapGate>
                )}
            />
            {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}

            <Paper sx={{ p: 2.5, mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>Identity</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Shown in the header and on resident-facing documents.</Typography>
                <CapGate cap="admin.society.save" mode="disable">
                    <Stack spacing={2}>
                        <TextField label="Complex name" value={name} onChange={(e) => setName(e.target.value)} size="small" fullWidth />
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                            <TextField label="Default car slots" type="number" value={car} onChange={(e) => setCar(e.target.value)} size="small" sx={{ maxWidth: 200 }} />
                            <TextField label="Default bike slots" type="number" value={bike} onChange={(e) => setBike(e.target.value)} size="small" sx={{ maxWidth: 200 }} />
                        </Stack>
                    </Stack>
                </CapGate>
            </Paper>

            <BankSection />

            <Paper sx={{ p: 2.5 }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5, gap: 1 }}>
                    <Box>
                        <Typography variant="subtitle1" fontWeight={700}>Enabled modules</Typography>
                        <Typography variant="body2" color="text.secondary">Choose which menu areas non-admin users can see.</Typography>
                    </Box>
                    <CapGate cap="setup.edit">
                        <Button size="small" variant="outlined" onClick={saveMods} disabled={saving || modulesQ.isLoading}>Save modules</Button>
                    </CapGate>
                </Stack>
                {modulesQ.isLoading ? <CircularProgress size={22} /> : (
                    <CapGate cap="setup.edit" mode="disable">
                        <Stack spacing={0.5}>
                            {MODULE_CATALOG.map((mod) => {
                                const locked = LOCKED_MODULE_KEYS.has(mod.key);
                                const on = locked ? true : settings[mod.key] !== false;
                                return (
                                    <FormControlLabel
                                        key={mod.key}
                                        sx={{ mx: 0, py: 0.75, px: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
                                        control={(
                                            <Switch
                                                checked={on}
                                                disabled={locked}
                                                onChange={(e) => setToggles({ ...settings, [mod.key]: e.target.checked })}
                                            />
                                        )}
                                        label={(
                                            <Box>
                                                <Typography fontWeight={600} fontSize="0.9rem">{mod.label}</Typography>
                                                <Typography variant="caption" color="text.secondary">{mod.description}{locked ? ' (always on)' : ''}</Typography>
                                            </Box>
                                        )}
                                    />
                                );
                            })}
                        </Stack>
                    </CapGate>
                )}
            </Paper>
        </Box>
    );
}
