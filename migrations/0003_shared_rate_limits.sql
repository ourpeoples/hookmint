-- Rate limits that every server instance shares. A use is recorded in the same transaction as the work it limits, so a
-- request that fails later does not keep its count, and two instances cannot both spend the last allowance.
--
-- Rows are short-lived: each is deleted the next time the same account and key is used after its window has passed.
-- "at" is milliseconds since the epoch, from the server that took the use.

CREATE TABLE rate_events (
  seq bigserial PRIMARY KEY,
  account_id text NOT NULL,
  key text NOT NULL,
  at bigint NOT NULL,
  weight bigint NOT NULL CHECK (weight >= 0)
);
CREATE INDEX rate_events_lookup ON rate_events (account_id, key, at);

ALTER TABLE rate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON rate_events TO hookmint_app
  USING (account_id = current_setting('app.account_id', true))
  WITH CHECK (account_id = current_setting('app.account_id', true));

GRANT SELECT, INSERT, DELETE ON rate_events TO hookmint_app;
GRANT USAGE ON SEQUENCE rate_events_seq_seq TO hookmint_app;
