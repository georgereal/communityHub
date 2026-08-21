import { createTheme } from '@mui/material/styles';

/**
 * CommunityHub MUI theme — match classic SPA typography (Inter + type scale).
 * Colors stay teal/slate for Property/Admin React screens.
 */
const FONT_SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

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
        text: {
            primary: '#202124',
            secondary: '#5f6368',
        },
        success: { main: '#15803d' },
        warning: { main: '#b45309' },
        error: { main: '#b91c1c' },
        info: { main: '#0369a1' },
    },
    typography: {
        fontFamily: FONT_SANS,
        fontSize: 14,
        htmlFontSize: 16,
        // Classic: --text-sm 0.875rem body, --text-xs 0.75rem captions, --text-lg 1.375rem titles
        h1: { fontFamily: FONT_SANS, fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
        h2: { fontFamily: FONT_SANS, fontSize: '1.375rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
        h3: { fontFamily: FONT_SANS, fontSize: '1.125rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
        h4: { fontFamily: FONT_SANS, fontSize: '1rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
        h5: { fontFamily: FONT_SANS, fontSize: '1.375rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: '-0.02em' },
        h6: { fontFamily: FONT_SANS, fontSize: '1rem', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
        subtitle1: { fontFamily: FONT_SANS, fontSize: '1rem', fontWeight: 600, lineHeight: 1.5 },
        subtitle2: { fontFamily: FONT_SANS, fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.5 },
        body1: { fontFamily: FONT_SANS, fontSize: '0.875rem', fontWeight: 400, lineHeight: 1.5 },
        body2: { fontFamily: FONT_SANS, fontSize: '0.875rem', fontWeight: 400, lineHeight: 1.5 },
        button: { fontFamily: FONT_SANS, fontSize: '0.875rem', fontWeight: 600, textTransform: 'none', letterSpacing: 0 },
        caption: { fontFamily: FONT_SANS, fontSize: '0.75rem', fontWeight: 400, lineHeight: 1.35 },
        overline: { fontFamily: FONT_SANS, fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em' },
    },
    shape: { borderRadius: 8 },
    components: {
        MuiCssBaseline: {
            styleOverrides: {
                body: {
                    fontFamily: FONT_SANS,
                    fontSize: '0.875rem',
                    lineHeight: 1.5,
                    WebkitFontSmoothing: 'antialiased',
                    MozOsxFontSmoothing: 'grayscale',
                },
            },
        },
        MuiButton: {
            defaultProps: { disableElevation: true },
            styleOverrides: {
                root: { fontFamily: FONT_SANS, fontSize: '0.875rem' },
            },
        },
        MuiInputBase: {
            styleOverrides: {
                root: { fontFamily: FONT_SANS, fontSize: '0.875rem' },
            },
        },
        MuiTableCell: {
            styleOverrides: {
                head: { fontFamily: FONT_SANS, fontSize: '0.75rem', fontWeight: 700 },
                body: { fontFamily: FONT_SANS, fontSize: '0.875rem' },
            },
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
                root: { fontFamily: FONT_SANS, fontWeight: 600, fontSize: '0.75rem' },
            },
        },
        MuiTypography: {
            styleOverrides: {
                root: { fontFamily: FONT_SANS },
            },
        },
    },
});
