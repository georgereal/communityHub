-- Update ledger_sync_settings for bidirectional sync
ALTER TABLE public.ledger_sync_settings 
ADD COLUMN IF NOT EXISTS last_sync_etag TEXT,
ADD COLUMN IF NOT EXISTS last_sync_pushed INTEGER DEFAULT 0;
