-- Hookmint schema, version 1.
--
-- Two database roles do all the runtime work, and neither owns anything:
--   hookmint_app     serves requests. Every table it can touch has row-level security that limits it to the account
--                    named in the transaction setting app.account_id. With no setting it sees nothing.
--   hookmint_worker  claims background work from the outbox, across accounts. It can see no other table.
-- The ledger and the audit log are append-only for both roles (no UPDATE or DELETE is granted), so the database,
-- not just the code, refuses to rewrite history.
--
-- Roles are created here if they do not exist. If your database user cannot create roles, create these two
-- LOGIN roles first (see docs/DATABASE.md) and this step will skip them. Set their passwords yourself.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hookmint_app') THEN
    CREATE ROLE hookmint_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hookmint_worker') THEN
    CREATE ROLE hookmint_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- One row per account. Locked (FOR UPDATE) to serialise anything that spends that account's credits.
CREATE TABLE accounts (
  account_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ads (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  brand_kit_id text,
  prompt text NOT NULL,
  duration_s integer NOT NULL,
  aspect_ratios jsonb NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  plans jsonb NOT NULL DEFAULT '[]',
  assets jsonb NOT NULL DEFAULT '{}',
  renders jsonb NOT NULL DEFAULT '[]',
  regenerations integer NOT NULL DEFAULT 0,
  variant_of text,
  error text,
  created_at text NOT NULL
);
CREATE INDEX ads_account_created ON ads (account_id, created_at DESC);
CREATE INDEX ads_account_status ON ads (account_id, status);
CREATE INDEX ads_kit ON ads (account_id, brand_kit_id, status);

CREATE TABLE brand_kits (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  logo_status text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX brand_kits_account ON brand_kits (account_id, logo_status);

CREATE TABLE brand_rules (
  kit_id text PRIMARY KEY,
  account_id text NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE idempotency (
  account_id text NOT NULL,
  key text NOT NULL,
  hash text NOT NULL,
  ad_id text NOT NULL,
  group_id text,
  result_ad_ids jsonb,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE variant_groups (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE renders (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  ad_id text NOT NULL,
  path text NOT NULL,
  bytes bigint NOT NULL
);
CREATE INDEX renders_account ON renders (account_id);

CREATE TABLE semantic_findings (
  account_id text NOT NULL,
  key text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE ledger (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  ad_id text,
  delta integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_account ON ledger (account_id);

CREATE TABLE reservations (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  ad_id text NOT NULL,
  amount integer NOT NULL,
  status text NOT NULL CHECK (status IN ('held', 'settled', 'released'))
);
CREATE INDEX reservations_account ON reservations (account_id, status);
CREATE INDEX reservations_ad ON reservations (account_id, ad_id);

-- Written in the same transaction as the change that needs the work done, so the two succeed or fail together.
CREATE TABLE outbox (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  claimed_until timestamptz
);
CREATE INDEX outbox_open ON outbox (created_at) WHERE done_at IS NULL;

-- "detail" is json, not jsonb: the hash chain covers its exact text, and jsonb would reorder keys.
CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  detail json NOT NULL,
  at text NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_account ON audit_log (account_id, seq);

-- Results of provider calls, so a retry after a restart does not pay twice. Keys start with "<account id>:".
CREATE TABLE provider_calls (
  account_id text NOT NULL,
  call_key text NOT NULL,
  provider text NOT NULL,
  result jsonb,
  cost_credits integer NOT NULL DEFAULT 0,
  latency_ms integer,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, call_key)
);

-- ---------- row-level security: every tenant table limits hookmint_app to its own account ----------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','ads','brand_kits','brand_rules','idempotency','variant_groups','renders','semantic_findings','ledger','reservations','outbox','audit_log','provider_calls']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I TO hookmint_app USING (account_id = current_setting('app.account_id', true)) WITH CHECK (account_id = current_setting('app.account_id', true))$p$, t);
  END LOOP;
END
$$;

-- The worker reads and finishes outbox rows for every account, and nothing else.
CREATE POLICY worker ON outbox TO hookmint_worker USING (true) WITH CHECK (true);

-- ---------- privileges ----------

GRANT USAGE ON SCHEMA public TO hookmint_app, hookmint_worker;
DO $$
BEGIN
  -- A test run installs the schema somewhere other than "public"; grant on whichever schema this is.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO hookmint_app, hookmint_worker', current_schema());
END
$$;

GRANT SELECT, INSERT, UPDATE ON accounts, ads, brand_kits, brand_rules, idempotency, variant_groups, renders, semantic_findings, reservations, provider_calls TO hookmint_app;
GRANT SELECT, INSERT ON ledger, audit_log TO hookmint_app;     -- append-only
GRANT SELECT, INSERT ON outbox TO hookmint_app;                -- a request queues work; it never finishes it
GRANT SELECT, UPDATE ON outbox TO hookmint_worker;
GRANT USAGE ON SEQUENCE audit_log_seq_seq TO hookmint_app;
