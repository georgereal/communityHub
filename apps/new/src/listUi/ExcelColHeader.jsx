import React, { useState } from 'react';
import {
    Box,
    Button,
    Divider,
    IconButton,
    Menu,
    MenuItem,
    TextField,
    Typography,
} from '@mui/material';
import {
    ArrowDownward as ArrowDownwardIcon,
    ArrowUpward as ArrowUpwardIcon,
    FilterList as FilterListIcon,
} from '@mui/icons-material';

export function sortAndFilterRows(rows, { filters = {}, sort, getText, getSort }) {
    const filtered = (rows || []).filter((row) => {
        for (const [key, raw] of Object.entries(filters)) {
            const q = String(raw || '').trim().toLowerCase();
            if (!q) continue;
            const hay = String(getText ? getText(row, key) : '').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
    if (!sort?.key) return filtered;
    const getter = getSort || getText;
    return [...filtered].sort((a, b) => {
        const av = getter(a, sort.key);
        const bv = getter(b, sort.key);
        const cmp = typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' });
        return sort.dir === 'desc' ? -cmp : cmp;
    });
}

export default function ExcelColHeader({ col, sort, filterValue, onSort, onFilter, onClear }) {
    const [anchor, setAnchor] = useState(null);
    const [draft, setDraft] = useState(filterValue || '');
    const sorted = sort?.key === col.key;
    const filtered = Boolean(String(filterValue || '').trim());

    const open = (e) => {
        e.stopPropagation();
        setDraft(filterValue || '');
        setAnchor(e.currentTarget);
    };
    const close = () => setAnchor(null);
    const applyFilter = () => {
        onFilter(draft);
        close();
    };

    let Icon = FilterListIcon;
    if (sorted && sort.dir === 'asc') Icon = ArrowUpwardIcon;
    else if (sorted && sort.dir === 'desc') Icon = ArrowDownwardIcon;

    return (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
            <Typography component="span" variant="body2" fontWeight={700}>{col.label}</Typography>
            <IconButton
                size="small"
                aria-label={`${col.label} sort and filter`}
                color={sorted || filtered ? 'primary' : 'default'}
                onClick={open}
                sx={{ p: 0.25 }}
            >
                <Icon sx={{ fontSize: 16 }} />
            </IconButton>
            <Menu
                open={Boolean(anchor)}
                anchorEl={anchor}
                onClose={close}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                slotProps={{ paper: { sx: { width: 240, p: 0.5 } } }}
            >
                {col.canSort ? (
                    <>
                        <MenuItem
                            selected={sorted && sort.dir === 'asc'}
                            onClick={() => { onSort(col.key, 'asc'); close(); }}
                        >
                            Sort A → Z
                        </MenuItem>
                        <MenuItem
                            selected={sorted && sort.dir === 'desc'}
                            onClick={() => { onSort(col.key, 'desc'); close(); }}
                        >
                            Sort Z → A
                        </MenuItem>
                    </>
                ) : null}
                {col.canFilter ? (
                    <Box sx={{ px: 1.5, py: 1 }} onKeyDown={(e) => e.stopPropagation()}>
                        {col.canSort ? <Divider sx={{ mb: 1 }} /> : null}
                        <TextField
                            size="small"
                            fullWidth
                            autoFocus
                            placeholder={col.placeholder || 'Contains…'}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') applyFilter();
                            }}
                            sx={{ mb: 0.75 }}
                        />
                        <Button size="small" fullWidth variant="contained" onClick={applyFilter}>
                            Filter
                        </Button>
                    </Box>
                ) : null}
                {sorted || filtered ? (
                    <MenuItem onClick={() => { onClear(col.key); close(); }}>
                        Clear
                    </MenuItem>
                ) : null}
            </Menu>
        </Box>
    );
}
