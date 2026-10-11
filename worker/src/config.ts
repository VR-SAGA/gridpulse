import raw from "../../config/slos.json";

export interface Target {
  id: string;
  name: string;
  url?: string;
  url_from_env?: string;
  path: string;
  timeout_ms: number;
  on_gcp: boolean;
}

export interface Slo {
  id: string;
  target: string;
  type: "availability" | "latency";
  objective: number;
  window_days: number;
  threshold_ms?: number;
  description: string;
}

export type Window = "5m" | "30m" | "1h" | "6h" | "3d";

export interface Rule {
  name: string;
  severity: "page" | "ticket";
  long: Window;
  short: Window;
  burn_rate: number;
  budget_spent: string;
}

export interface Config {
  targets: Target[];
  slos: Slo[];
  alerting: { min_events_long_window: number; rules: Rule[] };
}

export const config = raw as unknown as Config;

export const WINDOW_SECONDS: Record<Window, number> = {
  "5m": 300,
  "30m": 1800,
  "1h": 3600,
  "6h": 21600,
  "3d": 259200,
};

/** Latency threshold used to classify a probe as "fast" for a target. */
export function latencyThreshold(targetId: string): number {
  const slo = config.slos.find((s) => s.target === targetId && s.type === "latency");
  return slo?.threshold_ms ?? 800;
}
