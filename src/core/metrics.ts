/**
 * A small Prometheus-compatible metrics registry (text exposition format 0.0.4), with no dependency.
 *
 * Labels are always short, fixed vocabularies (a provider name, a stage, an error code, a route template). Never an
 * account id, an ad id, a prompt or any text from a user: that would leak data to whoever reads the metrics and would
 * make the number of series grow without bound. As a backstop each metric keeps at most MAX_SERIES label combinations;
 * beyond that new combinations are counted in `hookmint_metrics_dropped_series_total` instead of stored.
 */
const MAX_SERIES = 500;
const MAX_LABEL = 64;

type Labels = Record<string, string>;
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const clean = (v: unknown) => String(v ?? "").slice(0, MAX_LABEL);

abstract class Metric {
  protected series = new Map<string, { labels: Labels }>();
  constructor(readonly name: string, readonly help: string, protected labelNames: string[], protected registry: Registry) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Bad metric name ${name}`);
    for (const l of labelNames) if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(l) || l === "le") throw new Error(`Bad label name ${l}`);
  }
  protected key(labels: Labels): string | undefined {
    const parts = this.labelNames.map((n) => clean(labels[n]));
    const key = parts.join("\u0000");
    if (!this.series.has(key)) {
      if (this.series.size >= MAX_SERIES) {
        this.registry.dropped();
        return undefined;
      }
      this.series.set(key, { labels: Object.fromEntries(this.labelNames.map((n, i) => [n, parts[i]])) });
    }
    return key;
  }
  protected fmt(labels: Labels, extra?: Labels): string {
    const all = { ...labels, ...extra };
    const body = Object.entries(all).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
    return body ? `{${body}}` : "";
  }
  abstract render(): string[];
  header(type: string): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\n/g, " ")}`, `# TYPE ${this.name} ${type}`];
  }
}

export class Counter extends Metric {
  private values = new Map<string, number>();
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) return; // counters never go down
    const k = this.key(labels);
    if (k !== undefined) this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(this.labelNames.map((n) => clean(labels[n])).join("\u0000")) ?? 0;
  }
  render(): string[] {
    return [...this.header("counter"), ...[...this.values].map(([k, v]) => `${this.name}${this.fmt(this.series.get(k)!.labels)} ${v}`)];
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();
  set(labels: Labels, value: number): void {
    const k = this.key(labels);
    if (k !== undefined && Number.isFinite(value)) this.values.set(k, value);
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = this.key(labels);
    if (k !== undefined) this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(this.labelNames.map((n) => clean(labels[n])).join("\u0000")) ?? 0;
  }
  /** Forget every value. For gauges that are recomputed in full at each scrape. */
  reset(): void {
    this.values.clear();
    this.series.clear();
  }
  render(): string[] {
    return [...this.header("gauge"), ...[...this.values].map(([k, v]) => `${this.name}${this.fmt(this.series.get(k)!.labels)} ${v}`)];
  }
}

export class Histogram extends Metric {
  private data = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, labelNames: string[], registry: Registry, readonly buckets: number[]) {
    super(name, help, labelNames, registry);
    if (!buckets.length || buckets.some((b, i) => !(b > 0) || (i > 0 && b <= buckets[i - 1]))) throw new Error("Buckets must be positive and increasing");
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const k = this.key(labels);
    if (k === undefined) return;
    const d = this.data.get(k) ?? { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => { if (value <= b) d.counts[i]++; });
    d.sum += value;
    d.count++;
    this.data.set(k, d);
  }
  snapshot(labels: Labels = {}): { count: number; sum: number } {
    const d = this.data.get(this.labelNames.map((n) => clean(labels[n])).join("\u0000"));
    return { count: d?.count ?? 0, sum: d?.sum ?? 0 };
  }
  render(): string[] {
    const out = this.header("histogram");
    for (const [k, d] of this.data) {
      const labels = this.series.get(k)!.labels;
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${this.fmt(labels, { le: String(b) })} ${d.counts[i]}`));
      out.push(`${this.name}_bucket${this.fmt(labels, { le: "+Inf" })} ${d.count}`, `${this.name}_sum${this.fmt(labels)} ${d.sum}`, `${this.name}_count${this.fmt(labels)} ${d.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics: Metric[] = [];
  private droppedSeries?: Counter;

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames, this));
  }
  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames, this));
  }
  histogram(name: string, help: string, labelNames: string[] = [], buckets = SECONDS): Histogram {
    return this.add(new Histogram(name, help, labelNames, this, buckets));
  }
  private add<T extends Metric>(m: T): T {
    if (this.metrics.some((x) => x.name === m.name)) throw new Error(`Metric ${m.name} is already registered`);
    this.metrics.push(m);
    return m;
  }
  dropped() {
    (this.droppedSeries ??= this.counter("hookmint_metrics_dropped_series_total", "Label combinations not recorded because a metric hit its series limit.")).inc();
  }
  render(): string {
    return `${this.metrics.flatMap((m) => m.render()).join("\n")}\n`;
  }
}

export const SECONDS = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
export const CREDITS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** The process-wide registry and the metrics Hookmint records. */
export const registry = new Registry();
export const metrics = {
  httpRequests: registry.counter("hookmint_http_requests_total", "HTTP requests by route template, method and status.", ["method", "route", "status"]),
  httpDuration: registry.histogram("hookmint_http_request_duration_seconds", "HTTP request duration by route template.", ["route"]),
  authFailures: registry.counter("hookmint_auth_failures_total", "Requests refused for bad credentials.", ["kind"]),
  providerCalls: registry.counter("hookmint_provider_calls_total", "Provider calls by provider and outcome (ok, error, reused, refused_by_breaker).", ["provider", "outcome"]),
  providerErrors: registry.counter("hookmint_provider_errors_total", "Failed provider calls by provider and error code.", ["provider", "code"]),
  providerDuration: registry.histogram("hookmint_provider_call_duration_seconds", "Provider call duration, including retries.", ["provider"]),
  providerCredits: registry.counter("hookmint_provider_credits_total", "Credits attributed to finished provider calls (the cost model's units).", ["provider"]),
  breakerOpen: registry.gauge("hookmint_provider_breaker_open", "1 while a provider's circuit breaker is open.", ["provider"]),
  stageDuration: registry.histogram("hookmint_job_stage_duration_seconds", "Time spent in each stage of making an ad.", ["stage"]),
  jobs: registry.counter("hookmint_jobs_total", "Ads reaching a final state.", ["outcome"]),
  creditsReserved: registry.counter("hookmint_credits_reserved_total", "Credits reserved when work was approved.", ["kind"]),
  creditsSpent: registry.counter("hookmint_credits_spent_total", "Credits settled for finished work.", ["kind"]),
  creditsReleased: registry.counter("hookmint_credits_released_total", "Credits released because work failed or was cancelled."),
  adCost: registry.histogram("hookmint_ad_cost_credits", "Credits settled per finished ad: the p95 of this is the cost of a typical expensive ad.", [], CREDITS),
  queueDepth: registry.gauge("hookmint_queue_depth", "Outbox rows not yet finished, by topic.", ["topic"]),
  inflightRenders: registry.gauge("hookmint_render_concurrency", "Renders running now in this process."),
  inflightHandlers: registry.gauge("hookmint_inflight_handlers", "Background handlers running now in this process."),
  limitRefusals: registry.counter("hookmint_rate_limit_refusals_total", "Requests refused by one of Hookmint's own allowances.", ["limit"]),
  handlerErrors: registry.counter("hookmint_outbox_handler_errors_total", "Background handlers that crashed and will be redelivered.", ["topic"]),
  buildInfo: registry.gauge("hookmint_build_info", "Always 1. The version is a label.", ["version"]),
  startTime: registry.gauge("hookmint_process_start_time_seconds", "When this process started, in seconds since the epoch."),
  memory: registry.gauge("hookmint_process_resident_memory_bytes", "Resident memory of this process."),
};
metrics.startTime.set({}, Math.floor(Date.now() / 1000 - process.uptime()));
