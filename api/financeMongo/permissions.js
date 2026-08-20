/**
 * Thin wrappers around existing finance Mongo auth helpers.
 */
export {
    authorizeFinanceMongoMutation,
    BILLS_ACTIONS,
    DELETE_ACTIONS,
    VIEW_ACTIONS,
} from '../finance-mongo-mutations.js';

export const VIEW_PERMS = ['accounts.view', 'accounts.edit', 'accounts.bills_entry'];
