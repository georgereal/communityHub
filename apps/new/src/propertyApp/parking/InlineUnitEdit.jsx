import React, { useEffect, useRef, useState } from 'react';
import { Box, TextField, Typography } from '@mui/material';
import CapGate from '../../components/CapGate.jsx';
import { can } from '../../capabilities.js';
import {
    annotateUnitVehicles,
    poolSlotLabel,
    removeVehicle,
    saveVehicle,
    vehiclesOfType,
} from './api.js';
import { effectiveAllocationType } from '../../allocation.js';

function Tag({ vehicle, onEdit, onRemove, editable = true }) {
    const canUpdate = editable && can('parking.update');
    const alloc = effectiveAllocationType(vehicle);
    const tone = vehicle.status === 'OVERLIMIT'
        ? 'overlimit'
        : alloc === 'COMMON'
            ? 'pool'
            : alloc === 'NEIGHBOR'
                ? 'rented'
                : vehicle.status === 'INACTIVE'
                    ? 'dormant'
                    : 'base';
    const extra = poolSlotLabel(vehicle);
    const [editing, setEditing] = useState(false);
    const [plate, setPlate] = useState(vehicle.plate || '');

    useEffect(() => {
        setPlate(vehicle.plate || '');
        setEditing(false);
    }, [vehicle.plate, vehicle.id]);

    if (editing && canUpdate) {
        return (
            <TextField
                autoFocus
                size="small"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                onBlur={() => {
                    setEditing(false);
                    const next = plate.trim().toUpperCase();
                    if (next && next !== vehicle.plate) onEdit(next);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                        setPlate(vehicle.plate || '');
                        setEditing(false);
                    }
                }}
                sx={{ width: 130 }}
            />
        );
    }

    return (
        <span className={`parking-vchip parking-vchip--${tone}`}>
            <button type="button" className="parking-vchip__plate" onClick={() => canUpdate && setEditing(true)}>
                {vehicle.plate}
                {extra ? ` · ${extra}` : ''}
            </button>
            <CapGate cap="parking.delete">
                <button type="button" className="parking-vchip__x" title="Remove" onClick={() => onRemove()} disabled={!editable}>×</button>
            </CapGate>
        </span>
    );
}

function splitPlates(raw) {
    return String(raw || '')
        .toUpperCase()
        .split(/[\s,;]+/)
        .map((p) => p.trim())
        .filter(Boolean);
}

export function TypeEditor({ title, type, unit, onSaved, setError }) {
    const canUpdate = can('parking.update');
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);
    const vehicles = vehiclesOfType(annotateUnitVehicles(unit), type);

    const addPlates = async (raw) => {
        const plates = splitPlates(raw);
        if (!plates.length) return;
        setBusy(true);
        setError?.('');
        try {
            for (const plate of plates) {
                await saveVehicle({ unitId: unit.id, plate, type });
            }
            setDraft('');
            onSaved?.();
        } catch (err) {
            setError?.(err?.message || 'Could not add.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Box>
            {title ? (
                <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>{title}</Typography>
            ) : null}
            <div
                className="parking-chip-input"
                onClick={() => canUpdate && inputRef.current?.focus()}
            >
                {vehicles.map((v) => (
                    <Tag
                        key={v.id}
                        vehicle={v}
                        editable={!busy}
                        onEdit={async (plate) => {
                            setError?.('');
                            try {
                                await saveVehicle({ unitId: unit.id, plate, type: v.type }, v);
                                onSaved?.();
                            } catch (err) {
                                setError?.(err?.message || 'Could not update.');
                            }
                        }}
                        onRemove={async () => {
                            if (!window.confirm(`Remove ${v.plate}?`)) return;
                            setError?.('');
                            try {
                                await removeVehicle(unit.id, v.id);
                                onSaved?.();
                            } catch (err) {
                                setError?.(err?.message || 'Could not remove.');
                            }
                        }}
                    />
                ))}
                <CapGate cap="parking.update">
                    <input
                        ref={inputRef}
                        className="parking-chip-input__field"
                        value={draft}
                        disabled={busy}
                        placeholder={vehicles.length ? '' : 'Plates'}
                        aria-label={`Add ${type === 'BIKE' ? 'bike' : 'car'} plates`}
                        onChange={(e) => setDraft(e.target.value.toUpperCase())}
                        onPaste={(e) => {
                            const text = e.clipboardData.getData('text');
                            if (/[\s,;]/.test(text)) {
                                e.preventDefault();
                                addPlates(`${draft} ${text}`);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ',') {
                                e.preventDefault();
                                addPlates(draft);
                            }
                            if (e.key === 'Backspace' && !draft && vehicles.length) {
                                const last = vehicles[vehicles.length - 1];
                                if (last && window.confirm(`Remove ${last.plate}?`)) {
                                    e.preventDefault();
                                    setError?.('');
                                    removeVehicle(unit.id, last.id).then(() => onSaved?.()).catch((err) => {
                                        setError?.(err?.message || 'Could not remove.');
                                    });
                                }
                            }
                        }}
                        onBlur={() => {
                            if (draft.trim()) addPlates(draft);
                        }}
                    />
                </CapGate>
            </div>
        </Box>
    );
}
