import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { residentsTheme } from './theme.js';
import ResidentList from './pages/ResidentList.jsx';
import ResidentDetails from './pages/ResidentDetails.jsx';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

export default function ResidentsApp() {
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={residentsTheme}>
                <CssBaseline />
                <BrowserRouter basename="/residents">
                    <Routes>
                        <Route path="/" element={<ResidentList />} />
                        <Route path="/:residentId" element={<ResidentDetails />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </BrowserRouter>
            </ThemeProvider>
        </QueryClientProvider>
    );
}
