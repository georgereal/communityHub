import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Sync list search/filter criteria with the URL so list → detail → Back
 * restores the previous filtered view.
 *
 * @param {Record<string, string>} defaults
 */
export default function useListQueryParams(defaults) {
    const [searchParams, setSearchParams] = useSearchParams();
    const defaultsRef = useRef(defaults);
    defaultsRef.current = defaults;

    const values = useMemo(() => {
        const defs = defaultsRef.current;
        const next = {};
        for (const key of Object.keys(defs)) {
            const raw = searchParams.get(key);
            next[key] = raw !== null && raw !== '' ? raw : (defs[key] ?? '');
        }
        return next;
    }, [searchParams]);

    const setParams = useCallback((updates, { replace = true } = {}) => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            const defs = defaultsRef.current;

            Object.entries(updates).forEach(([key, value]) => {
                const empty =
                    value === null
                    || value === undefined
                    || value === ''
                    || value === false
                    || value === defs[key];

                if (empty) {
                    next.delete(key);
                } else if (value === true) {
                    next.set(key, 'true');
                } else {
                    next.set(key, String(value));
                }
            });

            return next;
        }, { replace });
    }, [setSearchParams]);

    const clearParams = useCallback(({ replace = true } = {}) => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            Object.keys(defaultsRef.current).forEach((key) => next.delete(key));
            return next;
        }, { replace });
    }, [setSearchParams]);

    return { values, setParams, clearParams, searchParams, setSearchParams };
}
