import { createTheme } from '@mui/material/styles';

/** CommunityHub-aligned MUI theme (teal/slate — avoid purple default). */
export const residentsTheme = createTheme({
    palette: {
        mode: 'light',
        primary: {
            main: '#0f766e',
            dark: '#0d5f59',
            light: '#14b8a6',
            contrastText: '#fff',
        },
        secondary: {
            main: '#334155',
        },
        background: {
            default: '#f1f5f9',
            paper: '#ffffff',
        },
        success: { main: '#15803d' },
        warning: { main: '#b45309' },
        error: { main: '#b91c1c' },
        info: { main: '#0369a1' },
    },
    typography: {
        fontFamily: '"DM Sans", "Segoe UI", system-ui, sans-serif',
        h5: { fontWeight: 700 },
        h6: { fontWeight: 700 },
        button: { textTransform: 'none', fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
        MuiButton: {
            defaultProps: { disableElevation: true },
        },
        MuiPaper: {
            defaultProps: { elevation: 0 },
            styleOverrides: {
                root: {
                    border: '1px solid',
                    borderColor: 'rgba(15, 23, 42, 0.08)',
                },
            },
        },
        MuiChip: {
            styleOverrides: {
                root: { fontWeight: 600 },
            },
        },
    },
});
