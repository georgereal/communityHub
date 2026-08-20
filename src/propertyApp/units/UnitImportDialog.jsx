import React, { useRef, useState } from 'react';
import {
    Alert,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Stack,
    Typography,
} from '@mui/material';
import { importUnitsExcel } from './api.js';

export default function UnitImportDialog({ open, onClose, onImported }) {
    const fileRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(null);

    const handleClose = () => {
        if (busy) return;
        setError('');
        setDone(null);
        onClose?.();
    };

    const onFile = async (file) => {
        if (!file) return;
        setBusy(true);
        setError('');
        try {
            const out = await importUnitsExcel(file);
            setDone(out.result || { updated: 0, created: 0, residents: 0 });
            onImported?.();
        } catch (err) {
            setError(err?.message || 'Import failed.');
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    return (
        <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md" scroll="paper">
            <DialogTitle>Import unit directory</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {error ? <Alert severity="error">{error}</Alert> : null}
                    {done ? (
                        <Alert severity="success">
                            Updated {done.updated || 0} · created {done.created || 0} · residents {done.residents || 0}
                        </Alert>
                    ) : (
                        <Typography variant="body2" color="text.secondary">
                            Excel workbook with a Units sheet (and optional Residents sheet), same template as classic Unit Directory.
                        </Typography>
                    )}
                    <input
                        ref={fileRef}
                        type="file"
                        hidden
                        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={(e) => onFile(e.target.files?.[0])}
                    />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} disabled={busy}>Close</Button>
                {!done ? (
                    <Button variant="contained" disabled={busy} onClick={() => fileRef.current?.click()}>
                        {busy ? <CircularProgress size={18} /> : 'Choose file'}
                    </Button>
                ) : null}
            </DialogActions>
        </Dialog>
    );
}
