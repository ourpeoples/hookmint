-- Ad results: which live ad each finished ad is running as, and its daily numbers.
--
-- Result rows are append-only: a correction is a newer row for the same day, never an UPDATE, so the history of what
-- was reported (and when) can always be reconstructed. The database enforces this with grants, like the ledger.

ALTER TABLE idempotency ADD COLUMN result jsonb;

CREATE TABLE ad_links (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  ad_id text NOT NULL,
  aspect_ratio text,
  platform text NOT NULL,
  platform_ad_id text NOT NULL,
  launch_mode text NOT NULL CHECK (launch_mode IN ('platform_experiment', 'same_ad_set', 'separate')),
  created_at text NOT NULL,
  UNIQUE (account_id, platform, platform_ad_id)
);
CREATE INDEX ad_links_ad ON ad_links (account_id, ad_id);

CREATE TABLE performance_snapshots (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  link_id text NOT NULL,
  date text NOT NULL CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
  spend numeric(14, 2) NOT NULL CHECK (spend >= 0),
  impressions bigint NOT NULL CHECK (impressions >= 0),
  clicks bigint NOT NULL CHECK (clicks >= 0 AND clicks <= impressions),
  conversions bigint NOT NULL CHECK (conversions >= 0 AND conversions <= impressions),
  currency text NOT NULL,
  timezone text NOT NULL,
  attribution_window text NOT NULL,
  metric_definition_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'import')),
  created_at text NOT NULL
);
CREATE INDEX snapshots_link ON performance_snapshots (account_id, link_id, date, seq);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_links', 'performance_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I TO hookmint_app USING (account_id = current_setting('app.account_id', true)) WITH CHECK (account_id = current_setting('app.account_id', true))$p$, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON ad_links TO hookmint_app;
GRANT SELECT, INSERT ON performance_snapshots TO hookmint_app;   -- append-only
GRANT USAGE ON SEQUENCE performance_snapshots_seq_seq TO hookmint_app;
