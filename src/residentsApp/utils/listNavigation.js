export function getCurrentListPath(location) {
    if (!location) return '';
    return `${location.pathname}${location.search || ''}`;
}

export function navigateToDetail(navigate, location, detailPath, extraState = {}) {
    navigate(detailPath, {
        state: {
            from: location?.state?.from || getCurrentListPath(location),
            ...extraState,
        },
    });
}

export function navigateBackToList(navigate, location, fallbackPath) {
    if (location?.state?.from) {
        navigate(-1);
        return;
    }
    navigate(fallbackPath);
}
