export function getCurrentListPath(location) {
    if (!location) return '';
    return `${location.pathname}${location.search || ''}`;
}

function softNavProgress() {
    void import('../../appShell/navProgress.js').then((m) => {
        m.beginSoftNavigation();
        m.endSoftNavigation();
    });
}

export function navigateToDetail(navigate, location, detailPath, extraState = {}) {
    softNavProgress();
    navigate(detailPath, {
        state: {
            from: location?.state?.from || getCurrentListPath(location),
            ...extraState,
        },
    });
}

export function navigateBackToList(navigate, location, fallbackPath) {
    softNavProgress();
    if (location?.state?.from) {
        navigate(-1);
        return;
    }
    navigate(fallbackPath);
}
