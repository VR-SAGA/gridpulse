// GridPulse edge monitor.
//
//   cron "* * * * *"    probe every target, roll results into D1 buckets
//   cron "*/5 * * * *"  evaluate SLOs and burn rates, open/close incidents
//   GET /api/status     JSON for the status page
//   GET /api/carbon     greenest 2-hour window in the GB grid forecast
//   GET /metrics        Prometheus text format (scrape with Grafana Cloud)
//   everything else     static status page from ./public

import { config, latencyThreshold, WINDOW_SECONDS, type Slo, type Target, type Window } from "./config";
import { github } from "./github";
import {
  bucketStart,
  budgetRemaining,
  evaluate,
  greenestWindow,
  sli,
  toCounts,
  type Counts,
  type Rollup,
} from "./slo";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  API_URL: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN?: string;
  INCIDENTS_ENABLED?: string;
}

const RESOLUTIONS = { fine: 300, coarse: 3600 } as const;
const RESOLVE_AFTER_SECONDS = 900; // hysteresis: stay quiet 15 min before closing
const PROBE_CRON = "* * * * *";

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

interface ProbeResult {
  target: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  fast: boolean;
  error?: string;
}

function targetUrl(t: Target, env: Env): string {
  const base = t.url_from_env ? (env as unknown as Record<string, string>)[t.url_from_env] : t.url;
  if (!base) throw new Error(`no URL configured for target ${t.id}`);
  return base.replace(/\/$/, "") + t.path;
}

async function probe(t: Target, env: Env): Promise<ProbeResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t.timeout_ms);
  try {
    const res = await fetch(targetUrl(t, env), {
      signal: ctrl.signal,
      headers: { "User-Agent": "gridpulse-probe/1.0", "Cache-Control": "no-cache" },
    });
    await res.arrayBuffer(); // include body transfer in latency
    const latencyMs = Date.now() - started;
    const ok = res.status < 500;
    return { target: t.id, status: res.status, latencyMs, ok, fast: ok && latencyMs < latencyThreshold(t.id) };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const error = ctrl.signal.aborted ? `timeout after ${t.timeout_ms} ms` : String(e);
    return { target: t.id, status: 0, latencyMs, ok: false, fast: false, error };
  } finally {
    clearTimeout(timer);
  }
}

async function runProbes(env: Env): Promise<void> {
  const ts = now();
  const results = await Promise.all(config.targets.map((t) => probe(t, env)));

  const upsert = env.DB.prepare(
    `INSERT INTO buckets (target, resolution, start_ts, total, ok, fast, latency_sum)
     VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
     ON CONFLICT (target, resolution, start_ts) DO UPDATE SET
       total = total + 1, ok = ok + ?4, fast = fast + ?5, latency_sum = latency_sum + ?6`,
  );
  const last = env.DB.prepare(
    `INSERT OR REPLACE INTO last_probe (target, ts, status, latency_ms, ok, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );

  const stmts = results.flatMap((r) => [
    ...Object.values(RESOLUTIONS).map((res) =>
      upsert.bind(r.target, res, bucketStart(ts, res), r.ok ? 1 : 0, r.fast ? 1 : 0, r.latencyMs),
    ),
    last.bind(r.target, ts, r.status, r.latencyMs, r.ok ? 1 : 0, r.error ?? null),
  ]);
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------------
// SLO evaluation
// ---------------------------------------------------------------------------

async function rollup(env: Env, target: string, resolution: number, since: number): Promise<Rollup> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(fast),0) AS fast
     FROM buckets WHERE target = ?1 AND resolution = ?2 AND start_ts >= ?3`,
  )
    .bind(target, resolution, since)
    .first<Rollup>();
  return row ?? { total: 0, ok: 0, fast: 0 };
}

interface TargetWindows {
  windows: Record<Window, Rollup>;
  budget: Rollup;
}

async function loadWindows(env: Env, target: string, budgetDays: number): Promise<TargetWindows> {
  const t = now();
  const entries = await Promise.all(
    (Object.keys(WINDOW_SECONDS) as Window[]).map(async (w) => {
      // Short windows read 5-minute buckets, long ones hourly buckets.
      const res = WINDOW_SECONDS[w] <= 21600 ? RESOLUTIONS.fine : RESOLUTIONS.coarse;
      return [w, await rollup(env, target, res, t - WINDOW_SECONDS[w])] as const;
    }),
  );
  const budget = await rollup(env, target, RESOLUTIONS.coarse, t - budgetDays * 86400);
  return { windows: Object.fromEntries(entries) as Record<Window, Rollup>, budget };
}

export interface SloStatus {
  id: string;
  target: string;
  description: string;
  objective: number;
  window_days: number;
  sli: number | null;
  events: number;
  budget_remaining: number;
  burn_rates: Record<Window, number>;
  firing: { rule: string; severity: string; burn_rate: number; budget_spent: string } | null;
  ts: number;
}

async function evaluateSlos(env: Env): Promise<SloStatus[]> {
  const cache = new Map<string, TargetWindows>();
  const statuses: SloStatus[] = [];

  for (const slo of config.slos) {
    const key = `${slo.target}:${slo.window_days}`;
    if (!cache.has(key)) cache.set(key, await loadWindows(env, slo.target, slo.window_days));
    const data = cache.get(key)!;

    const counts = Object.fromEntries(
      Object.entries(data.windows).map(([w, r]) => [w, toCounts(slo, r)]),
    ) as Record<Window, Counts>;
    const budgetCounts = toCounts(slo, data.budget);
    const result = evaluate(counts, slo.objective, config.alerting.rules, config.alerting.min_events_long_window);

    statuses.push({
      id: slo.id,
      target: slo.target,
      description: slo.description,
      objective: slo.objective,
      window_days: slo.window_days,
      sli: sli(budgetCounts),
      events: budgetCounts.total,
      budget_remaining: budgetRemaining(budgetCounts, slo.objective),
      burn_rates: result.burnRates,
      firing: result.firing && {
        rule: result.firing.name,
        severity: result.firing.severity,
        burn_rate: result.firing.burn_rate,
        budget_spent: result.firing.budget_spent,
      },
      ts: now(),
    });
  }

  const save = env.DB.prepare(`INSERT OR REPLACE INTO slo_status (slo_id, ts, json) VALUES (?1, ?2, ?3)`);
  await env.DB.batch(statuses.map((s) => save.bind(s.id, s.ts, JSON.stringify(s))));
  return statuses;
}

// ---------------------------------------------------------------------------
// Incidents as GitHub issues
// ---------------------------------------------------------------------------

interface IncidentRow {
  slo_id: string;
  issue_number: number | null;
  severity: string;
  rule: string;
  opened_ts: number;
  updated_ts: number;
}

const fmtPct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(3)}%`);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

function burnTable(s: SloStatus): string {
  const rows = (Object.keys(s.burn_rates) as Window[])
    .map((w) => `| ${w} | ${s.burn_rates[w].toFixed(2)}x |`)
    .join("\n");
  return `| Window | Burn rate |\n|---|---|\n${rows}`;
}

function openBody(s: SloStatus, slo: Slo): string {
  return [
    `**SLO:** \`${s.id}\` (${slo.description})`,
    `**Objective:** ${fmtPct(s.objective)} over ${s.window_days} days`,
    `**Rule:** ${s.firing!.rule}, burn rate above ${s.firing!.burn_rate}x on both windows (${s.firing!.budget_spent} of budget)`,
    `**Error budget remaining:** ${fmtPct(s.budget_remaining)}`,
    "",
    burnTable(s),
    "",
    "### Timeline (UTC)",
    `- ${iso(s.ts)}: detected by GridPulse edge probes`,
    "",
    "### Responder checklist",
    "- [ ] Acknowledge: assign yourself as Incident Commander",
    "- [ ] Check recent deploys and chaos experiments (Actions tab)",
    "- [ ] Mitigate first: roll back or stop the experiment",
    "- [ ] Follow the [runbook](../blob/main/docs/runbook.md)",
    "",
    "_Opened automatically by the GridPulse Worker. It will comment on severity changes and close the issue after 15 quiet minutes._",
  ].join("\n");
}

async function syncIncidents(env: Env, statuses: SloStatus[]): Promise<void> {
  const enabled = env.INCIDENTS_ENABLED !== "false" && !!env.GITHUB_TOKEN;
  const gh = enabled ? github(env.GITHUB_REPO, env.GITHUB_TOKEN!) : null;
  const { results: open } = await env.DB.prepare(`SELECT * FROM incidents`).all<IncidentRow>();
  const byId = new Map(open.map((r) => [r.slo_id, r]));
  const t = now();

  for (const s of statuses) {
    const slo = config.slos.find((x) => x.id === s.id)!;
    const existing = byId.get(s.id);

    try {
      if (s.firing && !existing) {
        const title = `[${s.firing.severity.toUpperCase()}] ${s.id}: error budget burning ${s.firing.burn_rate}x`;
        const number = gh
          ? await gh.open(title, openBody(s, slo), ["incident", `severity:${s.firing.severity}`, `slo:${s.id}`])
          : null;
        await env.DB.prepare(
          `INSERT INTO incidents (slo_id, issue_number, severity, rule, opened_ts, updated_ts) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        )
          .bind(s.id, number, s.firing.severity, s.firing.rule, t)
          .run();
      } else if (s.firing && existing) {
        if (existing.rule !== s.firing.rule && gh && existing.issue_number) {
          await gh.comment(
            existing.issue_number,
            `**${iso(t)}**: now matching **${s.firing.rule}** (${s.firing.severity}), was ${existing.rule}.\n\n${burnTable(s)}`,
          );
        }
        await env.DB.prepare(`UPDATE incidents SET severity = ?2, rule = ?3, updated_ts = ?4 WHERE slo_id = ?1`)
          .bind(s.id, s.firing.severity, s.firing.rule, t)
          .run();
      } else if (!s.firing && existing && t - existing.updated_ts >= RESOLVE_AFTER_SECONDS) {
        if (gh && existing.issue_number) {
          const minutes = Math.round((existing.updated_ts - existing.opened_ts) / 60);
          await gh.close(
            existing.issue_number,
            [
              `**${iso(t)}**: resolved. No burn-rate rule has matched for 15 minutes.`,
              `Burning for about ${minutes} min. Error budget remaining: ${fmtPct(s.budget_remaining)}.`,
              "",
              "**Next:** write a blameless postmortem using the [template](../blob/main/docs/postmortems/TEMPLATE.md) and link it here.",
            ].join("\n"),
          );
        }
        await env.DB.prepare(`DELETE FROM incidents WHERE slo_id = ?1`).bind(s.id).run();
      }
    } catch (e) {
      // GitHub being down must never break monitoring; retry next cycle.
      console.error(`incident sync failed for ${s.id}:`, e);
    }
  }
}

async function cleanup(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM buckets WHERE resolution = ?1 AND start_ts < ?2`).bind(RESOLUTIONS.fine, t - 7 * 86400),
    env.DB.prepare(`DELETE FROM buckets WHERE resolution = ?1 AND start_ts < ?2`).bind(RESOLUTIONS.coarse, t - 35 * 86400),
  ]);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(data: unknown, maxAge = 30): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${maxAge}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function loadStatus(env: Env) {
  const [slos, probes, incidents] = await Promise.all([
    env.DB.prepare(`SELECT json FROM slo_status`).all<{ json: string }>(),
    env.DB.prepare(`SELECT * FROM last_probe`).all(),
    env.DB.prepare(`SELECT * FROM incidents`).all<IncidentRow>(),
  ]);
  return {
    generated_at: iso(now()),
    repo: env.GITHUB_REPO,
    targets: config.targets.map(({ id, name, on_gcp }) => ({ id, name, on_gcp })),
    rules: config.alerting.rules,
    slos: slos.results.map((r) => JSON.parse(r.json) as SloStatus),
    probes: probes.results,
    incidents: incidents.results,
  };
}

async function metrics(env: Env): Promise<Response> {
  const s = await loadStatus(env);
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, samples: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) lines.push(`${name}{${labels}} ${v}`);
  };

  metric("gridpulse_probe_up", "Last probe succeeded (non-5xx).", "gauge",
    s.probes.map((p: any) => [`target="${p.target}"`, p.ok]));
  metric("gridpulse_probe_latency_seconds", "Last probe latency.", "gauge",
    s.probes.map((p: any) => [`target="${p.target}"`, p.latency_ms / 1000]));
  metric("gridpulse_slo_objective", "SLO target ratio.", "gauge",
    s.slos.map((x) => [`slo="${x.id}"`, x.objective]));
  metric("gridpulse_slo_sli", "SLI over the SLO window.", "gauge",
    s.slos.filter((x) => x.sli !== null).map((x) => [`slo="${x.id}"`, x.sli!]));
  metric("gridpulse_slo_error_budget_remaining", "Share of error budget left (negative = overspent).", "gauge",
    s.slos.map((x) => [`slo="${x.id}"`, x.budget_remaining]));
  metric("gridpulse_slo_burn_rate", "Error budget burn rate per window.", "gauge",
    s.slos.flatMap((x) => Object.entries(x.burn_rates).map(([w, v]) => [`slo="${x.id}",window="${w}"`, v] as [string, number])));
  metric("gridpulse_slo_alert_firing", "1 if a burn-rate rule is firing.", "gauge",
    s.slos.map((x) => [`slo="${x.id}",severity="${x.firing?.severity ?? "none"}"`, x.firing ? 1 : 0]));

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
}

interface CarbonSlot {
  from: string;
  to: string;
  intensity: { forecast: number; actual: number | null; index: string };
}

async function carbon(ctx: ExecutionContext): Promise<Response> {
  const cacheKey = new Request("https://gridpulse.internal/carbon");
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const from = new Date().toISOString().slice(0, 16) + "Z";
  const res = await fetch(`https://api.carbonintensity.org.uk/intensity/${from}/fw24h`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 60);

  const { data } = (await res.json()) as { data: CarbonSlot[] };
  const slots = data.map((d) => ({ from: d.from, to: d.to, intensity: d.intensity.forecast, index: d.intensity.index }));
  const best = greenestWindow(slots, 4); // 4 half-hours = 2 hours
  const body = {
    unit: "gCO2/kWh",
    source: "National Energy System Operator, carbonintensity.org.uk",
    now: slots[0] ?? null,
    greenest_2h: best && {
      from: slots[best.start]!.from,
      to: slots[best.start + 3]!.to,
      avg_intensity: Math.round(best.avg),
    },
    forecast: slots,
  };
  const response = json(body, 1800);
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") return json(await loadStatus(env));
    if (pathname === "/api/carbon") return carbon(ctx);
    if (pathname === "/metrics") return metrics(env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx): Promise<void> {
    if (event.cron === PROBE_CRON) {
      await runProbes(env);
      return;
    }
    const statuses = await evaluateSlos(env);
    await syncIncidents(env, statuses);
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
