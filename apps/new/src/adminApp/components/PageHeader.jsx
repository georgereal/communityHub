import React from 'react';
import { Box, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';

export default function PageHeader({ title, subtitle, actions }) {
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    return (
        <Stack direction="row" sx={{ mb: 1.75, gap: 1, alignItems: 'center', justifyContent: 'space-between' }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography component="h1" variant={isMobile ? 'subtitle1' : 'h5'} fontWeight={700} noWrap>
                    {title}
                </Typography>
                {isMobile || !subtitle ? null : (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, fontSize: '0.875rem' }}>
                        {subtitle}
                    </Typography>
                )}
            </Box>
            {actions ? (
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
                    {actions}
                </Stack>
            ) : null}
        </Stack>
    );
}
