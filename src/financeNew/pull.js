/**
 * Finance-New pull — scoped Mongo pack reload (never Postgres finance domain).
 */
import { reloadFinancePacks } from './load.js';

/**
 * @param {{ packs?: string[], force?: boolean } | string} [opts]
 *   packs: boot | ledger | bank | billing | nobroker | vouchers | voucherAggregates
 *   Legacy: pullState() or pullState({ domain: 'finance' }) reloads nothing extra —
 *   callers must pass packs for the screen they mutated.
 */
export async function pullState(opts = {}) {
    const packs = Array.isArray(opts?.packs)
        ? opts.packs
        : (typeof opts === 'object' && opts?.domain === 'finance' ? ['billing', 'ledger'] : null);
    if (!packs || !packs.length) {
        throw new Error('pullState requires packs: [...] — full hydrate is removed.');
    }
    return reloadFinancePacks(packs, { force: opts.force !== false });
}

export async function refreshFinanceNew(packs, opts = {}) {
    return pullState({ packs, ...opts });
}
