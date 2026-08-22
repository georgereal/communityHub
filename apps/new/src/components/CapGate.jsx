import React from 'react';
import { can } from '../capabilities.js';

function capAllowed({ cap, any, all, not }) {
    if (not && can(not)) return false;
    if (cap && !can(cap)) return false;
    if (any?.length && !any.some((id) => can(id))) return false;
    if (all?.length && !all.every((id) => can(id))) return false;
    return true;
}

/**
 * React RBAC gate — hide (default) or disable children when capability is missing.
 *
 *   <CapGate cap="units.create"><Button>Add unit</Button></CapGate>
 *   <CapGate cap="setup.edit" mode="disable"><Stack>…form fields…</Stack></CapGate>
 */
export default function CapGate({
    cap,
    any,
    all,
    not,
    mode = 'hide',
    children,
    fallback = null,
}) {
    const allowed = capAllowed({ cap, any, all, not });

    if (mode === 'disable') {
        if (!allowed) {
            return (
                <fieldset
                    disabled
                    className="cap-gate-fieldset"
                    style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
                >
                    {children}
                </fieldset>
            );
        }
        return children;
    }

    if (!allowed) return fallback;
    return children;
}

export { capAllowed as reactCapAllowed };
