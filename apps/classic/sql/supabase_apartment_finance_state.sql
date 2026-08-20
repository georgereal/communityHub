-- Bulk finance state for /api/state?domain=finance (single round-trip).
-- Apply in Supabase SQL Editor. Safe to re-run.

CREATE OR REPLACE FUNCTION get_apartment_finance_state(p_apartment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'transactions', COALESCE((
      SELECT jsonb_agg(row_to_json(t) ORDER BY t.date DESC)
      FROM transactions t WHERE t.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'vendors', COALESCE((
      SELECT jsonb_agg(row_to_json(v) ORDER BY v.last_used_at DESC NULLS LAST)
      FROM expense_vendors v WHERE v.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'subCategories', COALESCE((
      SELECT jsonb_agg(row_to_json(s) ORDER BY s.last_used_at DESC NULLS LAST)
      FROM expense_sub_categories s WHERE s.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceInvoices', COALESCE((
      SELECT jsonb_agg(row_to_json(i) ORDER BY i.due_date)
      FROM maintenance_invoices i WHERE i.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceAllocations', COALESCE((
      SELECT jsonb_agg(row_to_json(a))
      FROM maintenance_payment_allocations a WHERE a.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceChargeHeads', COALESCE((
      SELECT jsonb_agg(row_to_json(h) ORDER BY h.sort_order)
      FROM maintenance_charge_heads h WHERE h.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceInvoiceLines', COALESCE((
      SELECT jsonb_agg(row_to_json(l))
      FROM maintenance_invoice_lines l WHERE l.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenancePenaltyRules', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.sort_order)
      FROM maintenance_penalty_rules r WHERE r.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceBillingGroups', COALESCE((
      SELECT jsonb_agg(row_to_json(g) ORDER BY g.sort_order)
      FROM maintenance_billing_groups g WHERE g.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceBillingGroupUnits', COALESCE((
      SELECT jsonb_agg(row_to_json(u))
      FROM maintenance_billing_group_units u WHERE u.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceBillingBatches', COALESCE((
      SELECT jsonb_agg(row_to_json(b) ORDER BY b.created_at DESC)
      FROM maintenance_billing_batches b WHERE b.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceBillingBatchSkips', COALESCE((
      SELECT jsonb_agg(row_to_json(s))
      FROM maintenance_billing_batch_skips s WHERE s.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'maintenanceReminderLog', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC)
      FROM maintenance_reminder_log r WHERE r.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'bankStatementImports', COALESCE((
      SELECT jsonb_agg(row_to_json(i) ORDER BY i.created_at DESC)
      FROM bank_statement_imports i WHERE i.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'bankStatementLines', COALESCE((
      SELECT jsonb_agg(row_to_json(l) ORDER BY l.line_date, l.line_order, l.source_row_index)
      FROM bank_statement_lines l WHERE l.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'bankClassificationRules', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.priority DESC, r.created_at)
      FROM bank_classification_rules r WHERE r.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'ledgerAccounts', COALESCE((
      SELECT jsonb_agg(row_to_json(a) ORDER BY a.code)
      FROM chart_of_accounts a WHERE a.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'journalEntries', COALESCE((
      SELECT jsonb_agg(row_to_json(e) ORDER BY e.entry_date DESC)
      FROM journal_entries e WHERE e.apartment_id = p_apartment_id
    ), '[]'::jsonb),
    'journalLines', COALESCE((
      SELECT jsonb_agg(row_to_json(l))
      FROM journal_lines l WHERE l.apartment_id = p_apartment_id
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION get_apartment_finance_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_apartment_finance_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_apartment_finance_state(uuid) TO service_role;
