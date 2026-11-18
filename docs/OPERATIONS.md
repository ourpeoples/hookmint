# Operations

What to set up, watch and rehearse before real customers depend on Hookmint. Nothing here has been proven in a real
production deployment yet; the tools exist and are tested, and each section says what is still your decision.

## Metrics

Set `HOOKMINT_METRICS_TOKEN` (at least 24 characters, for example `openssl rand -hex 24`) and `GET /metrics` serves
Prometheus text to a caller that sends `Authorization: Bearer <token>`. Without the setting the endpoint does not exist.
Bad tokens count toward the failed-login limit.

Labels are short fixed vocabularies (provider, stage, error code, route template such as `/v1/ads/{id}`). There is never
an account id, ad id, prompt or credential in the output, and each metric stops recording new label combinations after 500.

| Metric | Answers |
| --- | --- |
| `hookmint_job_stage_duration_seconds{stage}` | Which stage is slow: `script`, `generate_scene`, `render`, `semantic`, `logo` |
| `hookmint_provider_calls_total{provider,outcome}` | `ok`, `error` (every failed attempt), `reused` (a retry served from the stored result), `refused_by_breaker` |
| `hookmint_provider_errors_total{provider,code}` | Which provider is failing, and how |
| `hookmint_provider_call_duration_seconds{provider}` | Provider latency, retries included |
| `hookmint_provider_breaker_open{provider}` | 1 while calls to a failing provider are paused |
| `hookmint_ad_cost_credits` (histogram) | Credits settled per finished ad. Its 95th percentile is the cost of an expensive ad. Credits are the cost model's units; today they are placeholders, not provider prices |
| `hookmint_credits_reserved_total`, `_spent_total`, `_released_total` | Money in flight, spent, and given back after failures |
| `hookmint_provider_credits_total{provider}` | Where the credits go |
| `hookmint_jobs_total{outcome}` | `completed`, `failed`, `cancelled` |
| `hookmint_queue_depth{topic}` | Unfinished background work, from the database, so it is the same on every instance |
| `hookmint_render_concurrency`, `hookmint_inflight_handlers` | Work running in this process now |
| `hookmint_rate_limit_refusals_total{limit}` | Which allowance people are hitting |
| `hookmint_http_requests_total`, `hookmint_http_request_duration_seconds` | Traffic and latency by route and status |
| `hookmint_auth_failures_total{kind}` | Guessing: `credentials`, `download_link`, `metrics_token` |
| `hookmint_outbox_handler_errors_total{topic}` | Background work that crashed and will be redelivered |

Counters count only changes that were committed: a rolled-back request does not move them.

Suggested alerts (tune to your traffic): `hookmint_provider_breaker_open == 1` for 5 minutes; the ratio of
`hookmint_jobs_total{outcome="failed"}` to completed above 5% over an hour; `hookmint_queue_depth` rising for 10
minutes; the 95th percentile of `hookmint_job_stage_duration_seconds{stage="render"}` close to `HOOKMINT_RENDER_TIMEOUT_S`;
a jump in `hookmint_auth_failures_total`.

## Tracing

Every request gets an `x-request-id`. It is written into the work the request queues, so the background script, generation and
render logs (`"msg": "job stage"`) carry the `request_id`, `account_id` and `job_id` of the request that asked for them, even
when another instance runs them. Searching the logs for one request id follows an ad from the API call to the finished video.
That covers the debugging case "which request made this ad, and where did it stall".

There is no OpenTelemetry SDK and no spans. Adding one pulls in a large dependency tree and needs a collector to send to; the log
correlation above is the part that does not. If you run a collector, adding spans around `stage()` in `src/core/service.ts`
is the place to start.

## Backups, restore and the restore drill

State is in Postgres; finished videos and downloaded media are files in `HOOKMINT_DATA_DIR`. Both need backing up.

- **Database.** Use your host's point-in-time recovery (continuous WAL archiving plus periodic base backups). Suggested starting
  targets: recovery point 5 minutes, recovery time 1 hour. These are targets for you to choose and prove, not claims about
  this project. Keep backups in another region or account than the database.
- **Files.** Take volume snapshots of `HOOKMINT_DATA_DIR`, or move to object storage. If the database is restored to a point
  newer than the file backup, a video's record can point at a missing file; its download link then answers "not found", and
  `npm run renders:prune` tidies such records.
- **Drill, at least quarterly, and after any change to the schema:** restore the latest backup to a scratch database, apply
  `npm run db:migrate`, then run

  ```
  HOOKMINT_DATABASE_ADMIN_URL=... HOOKMINT_DATABASE_URL=... HOOKMINT_DATABASE_WORKER_URL=... npm run db:verify
  ```

  It checks, read-only, that: every migration is applied and unchanged; the two runtime roles have no extra powers; row-level
  security is on and forced for every table holding account data, with its policy; the ledger, audit log and results cannot be changed by
  the application; the worker role reaches only the outbox; an application connection with no account set sees nothing and an account sees only
  its own rows; every account's audit log is still an unbroken hash chain; and no balance is negative. Then start a server against the
  restored copy and confirm `/readyz` reports `postgres` and ready. Record how long the whole drill took: that is your measured recovery time.
- Run `npm run db:verify` after each deploy too. It exits 1 on any failure.

## Retention and deletion (decisions for you, with a recommendation)

What is stored, and where:

| Data | Where | Personal data? | Suggested retention |
| --- | --- | --- | --- |
| Prompts, scripts, plans | `ads` | Possibly (customer-written text) | Life of the account, then delete |
| Brand kits, rules, logos | `brand_kits`, `brand_rules`, logo files | Business data | Life of the account |
| Finished videos, downloaded media | `HOOKMINT_DATA_DIR`, `renders` | Possibly (faces, voices if uploaded) | 90 days, then `npm run renders:prune` |
| Provider call results | `provider_calls` | Mirrors scripts and media addresses | 30 days is enough for retry safety |
| Ledger | `ledger` | Account ids and amounts | Financial records: keep as your accountants require |
| Audit log | `audit_log` | Actor and action, ids, and free text such as an override reason | See below |
| Ad results | `performance_snapshots`, `ad_links` | Aggregate numbers | Life of the account |
| Rate counters | `rate_events` | No | Pruned automatically |

**The audit log and deletion requests.** The audit log is append-only and hash-chained on purpose, and that is in tension with a
request to erase personal data. The decision to make: keep audit entries free of personal data, so nothing in them needs erasing. Today
the entries hold ids, counts and credit amounts, plus one free-text field (`override_reason` on brand-rule overrides) that a user
could fill with personal data. The recommended direction is to store a salted hash of such free text instead of the text itself,
or to hold the text in a separate table that can be deleted while the chain keeps only its hash. Neither is built. Take legal advice
on what your jurisdictions require before promising anything to customers.

**Erasing an account.** There is no command that erases an account's data yet. Deleting rows needs the owner role (the
application cannot delete), and the order matters because of row-level security and foreign references. This is a gap to close
before accepting customers who can ask for deletion.

## Disk and renders

- Each render has a deadline, `HOOKMINT_RENDER_TIMEOUT_S` (default 240). A render still running then is cancelled, its slot is freed at once,
  and the ad fails with a plain message. `HOOKMINT_RENDER_CONCURRENCY` bounds renders per process.
- One account may run at most `maxActiveJobs` videos at once (a per-account limit, shared across instances).
- An account may hold at most `maxStoredBytes` of finished videos (default 10 GiB, set through `HOOKMINT_LIMITS`). Above it new videos are
  refused until space is freed with `npm run renders:prune`.
- New videos are refused when the render folder's disk has less than `HOOKMINT_MIN_FREE_DISK_MB` (default 512) free, so one account cannot fill the
  disk for everyone.
- Downloaded media under `HOOKMINT_DATA_DIR/assets/fetched` is a cache that can be deleted at any time; it is fetched again when needed.

## Remotion licence

Remotion is free for individuals and companies of up to three people; larger companies need a paid licence. In production with
`HOOKMINT_RENDERER=remotion` the server refuses to start until you set `HOOKMINT_REMOTION_LICENSE_ACK=1`, which records that you
checked your own situation. Outside production it logs a warning.
