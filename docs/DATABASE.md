# Database

Hookmint keeps its state in Postgres (16 or newer). Without a database it runs from memory, which is for development
and demos only: every ad and credit is lost on restart.

## What protects the data

- **Two runtime roles, neither owns anything.** `hookmint_app` serves requests. `hookmint_worker` claims background
  work from the outbox. Migrations run as a third, owner role that the running server never uses.
- **Row-level security on every tenant table.** Each request is one transaction that begins by setting
  `app.account_id` for that transaction only. The policies compare every row's `account_id` to it, for reads and
  writes. With no setting, `hookmint_app` sees nothing. A query that forgets its `WHERE account_id = ...` still
  cannot reach another account. The tests try this with raw SQL.
- **Append-only history.** `ledger` and `audit_log` grant `hookmint_app` only SELECT and INSERT. The database refuses
  to rewrite them even if the application code is wrong. The audit log is also hash-chained.
- **The worker sees only the outbox.** It can read and finish queued work for all accounts and nothing else.
- **No SQL, table names or addresses reach clients.** Database errors become plain messages.

## Set up

1. Create a database and an owner role for migrations. Create the two runtime roles, or let migration `0001` create
   them if the owner may create roles:

   ```sql
   CREATE ROLE hookmint_app    LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
   CREATE ROLE hookmint_worker LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
   ```

   Never make either role a superuser or give it `BYPASSRLS`; both would switch the protection off.
2. Apply migrations as the owner:

   ```
   HOOKMINT_DATABASE_ADMIN_URL=postgres://owner:...@host/hookmint npm run db:migrate
   ```

   or set `HOOKMINT_MIGRATE_ON_START=1` (with the admin URL) to apply them when the server starts. Several instances
   starting together are safe: one migrator runs at a time.
3. Point the server at the two roles:

   ```
   HOOKMINT_DATABASE_URL=postgres://hookmint_app:...@host/hookmint
   HOOKMINT_DATABASE_WORKER_URL=postgres://hookmint_worker:...@host/hookmint
   ```

   They must be different roles. `/readyz` reports `"store": "postgres"` and turns 503 if the database is unreachable.

## Changing the schema

Add a new numbered file in `migrations/` (`0002_what_it_does.sql`). Never edit one that has been applied anywhere: the
runner records each file's checksum and refuses to start if an applied one changed. Every new tenant table needs
`account_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the `tenant` policy, and the narrowest grants that work.

## How concurrency is handled

- Ads carry a version. Every change is `UPDATE ... WHERE version = <what was read>`, after `SELECT ... FOR UPDATE`
  where two writers could meet, so a stale write is refused, not merged.
- Spending locks the account's row, so two approvals can never spend the same credits.
- Idempotency keys take an advisory lock, so two instances racing on one key make one ad.
- Work is written to the outbox in the same transaction as the change that needs it, and claimed with
  `FOR UPDATE SKIP LOCKED` and a lease. A crash after commit leaves the row to be picked up again; handlers ignore
  repeated or stale work.
- Finished provider calls are stored (`provider_calls`), so a retry after a restart reuses the result.

## Known limits

- A provider call that was in flight when a server died is made again on retry. Providers without their own idempotency
  keys may bill twice for it. Finished calls are never repeated.
- **Shared across instances (in the database):** the hourly allowances (new ads, variants, brand kits, rule changes, paid
  actions, ad links, result updates) and the daily download allowance (count and bytes). They are recorded in
  `rate_events`, one use per row, in a short transaction of their own that commits at once. So every instance counts the
  same uses, a use counts even if the request fails later (errors cannot be used to hammer the server), a refusal records
  nothing, and a replay of an idempotent request never counts. Rows are removed when the same account and limit is next used
  after its window has passed.
- **Still per instance:** the per-minute request allowance, the failed-login counter and the provider circuit breakers.
  With N instances behind a load balancer the per-minute allowance is up to N times the setting, and a guesser gets N times
  the failed attempts. These are abuse brakes rather than cost controls; shared versions would need Redis.
- Downloaded media and rendered videos are files on the server's disk (`HOOKMINT_DATA_DIR`), not in the database. With
  several instances they need shared storage; object storage is future work.
- Backups, point-in-time recovery and connection pooling (PgBouncer in transaction mode works, because the account
  setting is transaction-local) are the operator's job.

## Testing

`npm run test:pg` runs the whole offline suite against Postgres, plus tests for row-level security, privileges,
cross-instance races, durability and migrations. It needs a scratch database and a superuser:

```
HOOKMINT_TEST_DATABASE_URL=postgres://postgres:...@localhost:5432/scratch npm run test:pg
```

CI runs it against a `postgres:16` service container.
