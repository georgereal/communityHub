import React, { useRef, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    FormControlLabel,
    FormLabel,
    Radio,
    RadioGroup,
    Stack,
    Typography,
} from '@mui/material';
import { CloudUpload as UploadIcon } from '@mui/icons-material';
import { importResidentsFromSheet, parseLegacyResidentFile } from '../api.js';

const MODES = [
    {
        value: 'update_listed',
        label: 'Update listed flats',
        hint: 'Match by flat + name + kind; update existing rows and insert new ones. Other flats unchanged.',
    },
    {
        value: 'replace_listed',
        label: 'Replace listed flats',
        hint: 'For each flat in the file, remove existing people then insert the file rows. Other flats unchanged.',
    },
    {
        value: 'full_replace',
        label: 'Full replace (all flats)',
        hint: 'Delete every resident for this society, then import the file. Destructive.',
    },
];

export default function ResidentImportDialog({ open, onClose, onImported }) {
    const fileRef = useRef(null);
    const [step, setStep] = useState('pick'); // pick | preview | done
    const [mode, setMode] = useState('update_listed');
    const [parsed, setParsed] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);

    const reset = () => {
        setStep('pick');
        setMode('update_listed');
        setParsed(null);
        setBusy(false);
        setError('');
        setResult(null);
        if (fileRef.current) fileRef.current.value = '';
    };

    const handleClose = () => {
        if (busy) return;
        reset();
        onClose?.();
    };

    const onFile = async (file) => {
        if (!file) return;
        setBusy(true);
        setError('');
        try {
            const next = await parseLegacyResidentFile(file);
            setParsed(next);
            setStep('preview');
        } catch (err) {
            setError(err?.message || 'Could not parse file.');
        } finally {
            setBusy(false);
        }
    };

    const applyImport = async () => {
        if (!parsed?.residents?.length) return;
        setBusy(true);
        setError('');
        try {
            const out = await importResidentsFromSheet(parsed.residents, mode);
            setResult(out);
            setStep('done');
            onImported?.(out);
        } catch (err) {
            setError(err?.message || 'Import failed.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={handleClose}
            fullWidth
            maxWidth="lg"
            scroll="paper"
            slotProps={{ paper: { sx: { maxHeight: '90vh' } } }}
        >
            <DialogTitle>Import residents</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}

                    {step === 'pick' ? (
                        <>
                            <Typography variant="body2" color="text.secondary">
                                Upload an owner/tenant Excel workbook (sheets named owner details / tenant details)
                                or a CSV with flat and name columns.
                            </Typography>
                            <FormControl>
                                <FormLabel>Import mode</FormLabel>
                                <RadioGroup
                                    value={mode}
                                    onChange={(e) => setMode(e.target.value)}
                                >
                                    {MODES.map((m) => (
                                        <FormControlLabel
                                            key={m.value}
                                            value={m.value}
                                            control={<Radio size="small" />}
                                            label={(
                                                <Box sx={{ py: 0.5 }}>
                                                    <Typography variant="body2" fontWeight={600}>{m.label}</Typography>
                                                    <Typography variant="caption" color="text.secondary">{m.hint}</Typography>
                                                </Box>
                                            )}
                                        />
                                    ))}
                                </RadioGroup>
                            </FormControl>
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                                hidden
                                onChange={(e) => onFile(e.target.files?.[0])}
                            />
                            <Button
                                variant="contained"
                                startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <UploadIcon />}
                                disabled={busy}
                                onClick={() => fileRef.current?.click()}
                            >
                                Choose file
                            </Button>
                        </>
                    ) : null}

                    {step === 'preview' && parsed ? (
                        <>
                            <Typography fontWeight={700}>{parsed.fileLabel || 'Selected file'}</Typography>
                            <Alert severity="info">
                                <strong>{parsed.ownerCount}</strong> owner row(s)
                                {' · '}
                                <strong>{parsed.tenantCount}</strong> tenant row(s)
                                {' · '}
                                <strong>{parsed.unitCount}</strong> flat(s)
                                {parsed.sheetNames?.length ? (
                                    <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                                        {parsed.sheetNames.join(', ')}
                                    </Typography>
                                ) : null}
                            </Alert>
                            <Typography variant="body2" color="text.secondary">
                                Mode: {MODES.find((m) => m.value === mode)?.label || mode}
                            </Typography>
                        </>
                    ) : null}

                    {step === 'done' ? (
                        <Alert severity="success">
                            Imported {result?.count ?? 0} resident row(s).
                        </Alert>
                    ) : null}
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
                {step === 'pick' ? (
                    <Button onClick={handleClose} disabled={busy}>Cancel</Button>
                ) : null}
                {step === 'preview' ? (
                    <>
                        <Button
                            onClick={() => {
                                setParsed(null);
                                setStep('pick');
                                setError('');
                            }}
                            disabled={busy}
                        >
                            Back
                        </Button>
                        <Button variant="contained" onClick={applyImport} disabled={busy}>
                            {busy ? 'Importing…' : 'Apply import'}
                        </Button>
                    </>
                ) : null}
                {step === 'done' ? (
                    <>
                        <Button
                            onClick={() => {
                                reset();
                                setStep('pick');
                            }}
                        >
                            Import another
                        </Button>
                        <Button variant="contained" onClick={handleClose}>Done</Button>
                    </>
                ) : null}
            </DialogActions>
        </Dialog>
    );
}
