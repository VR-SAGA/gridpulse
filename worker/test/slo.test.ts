import { describe, expect, it } from "vitest";
import { config, type Window } from "../src/config";
import { bucketStart, budgetRemaining, burnRate, evaluate, greenestWindow, toCounts, type Counts } from "../src/slo";

const rules = config.alerting.rules;
const all = (c: Counts): Record<Window, Counts> => ({ "5m": c, "30m": c, "1h": c, "6h": c, "3d": c });

describe("burnRate", () => {
  it("is 1 when errors exactly match the allowance", () => {
    expect(burnRate({ total: 1000, good: 999 }, 0.999)).toBeCloseTo(1);
  });
  it("is 14.4 at 1.44% errors on a 99.9% SLO", () => {
    expect(burnRate({ total: 10000, good: 9856 }, 0.999)).toBeCloseTo(14.4);
  });
  it("is 0 with no traffic", () => {
    expect(burnRate({ total: 0, good: 0 }, 0.999)).toBe(0);
  });
});

describe("budgetRemaining", () => {
  it("halves when half the allowed errors are used", () => {
    expect(budgetRemaining({ total: 1000, good: 997.5 }, 0.995)).toBeCloseTo(0.5);
  });
  it("goes negative when overspent", () => {
    expect(budgetRemaining({ total: 100, good: 90 }, 0.995)).toBeLessThan(0);
  });
});

describe("toCounts", () => {
  it("uses ok for availability and fast for latency", () => {
    const r = { total: 10, ok: 9, fast: 7 };
    expect(toCounts({ type: "availability" }, r).good).toBe(9);
    expect(toCounts({ type: "latency" }, r).good).toBe(7);
  });
});

describe("evaluate", () => {
  it("fires fast-burn on a hard outage", () => {
    const res = evaluate(all({ total: 60, good: 0 }), 0.995, rules, 10);
    expect(res.firing?.name).toBe("fast-burn");
  });

  it("stays quiet when only the short window is bad (blip)", () => {
    const w = all({ total: 60, good: 60 });
    w["5m"] = { total: 5, good: 0 };
    expect(evaluate(w, 0.995, rules, 10).firing).toBeNull();
  });

  it("resets quickly once the short window recovers", () => {
    const w = all({ total: 60, good: 0 });
    w["5m"] = { total: 5, good: 5 };
    w["30m"] = { total: 30, good: 30 };
    w["6h"] = { total: 360, good: 360 };
    expect(evaluate(w, 0.995, rules, 10).firing).toBeNull();
  });

  it("needs enough events in the long window", () => {
    expect(evaluate(all({ total: 3, good: 0 }), 0.995, rules, 10).firing).toBeNull();
  });

  it("raises a ticket for a slow, steady burn", () => {
    // 1% errors on a 99.5% SLO = 2x burn: above slow (1x), below medium (6x).
    expect(evaluate(all({ total: 1000, good: 990 }), 0.995, rules, 10).firing?.name).toBe("slow-burn");
  });
});

describe("helpers", () => {
  it("aligns buckets", () => {
    expect(bucketStart(1_000_123, 300)).toBe(999_900);
  });
  it("finds the greenest window", () => {
    const slots = [300, 250, 100, 90, 95, 400].map((intensity) => ({ intensity }));
    expect(greenestWindow(slots, 3)).toEqual({ start: 2, avg: 95 });
  });
});
