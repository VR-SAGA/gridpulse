// k6 load test for the tariff endpoint.
// Thresholds mirror the SLOs, so a run "fails" exactly when it would
// have burned error budget faster than allowed.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL;
const PEAK = Number(__ENV.PEAK_VUS || 20);
const HOLD = __ENV.PEAK_DURATION || "2m";

export const options = {
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  stages: [
    { duration: "30s", target: Math.ceil(PEAK / 2) },
    { duration: "30s", target: PEAK },
    { duration: HOLD, target: PEAK },
    { duration: "20s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.005"], // api-availability: 99.5%
    "http_req_duration{expected_response:true}": ["p(99)<800"], // api-latency: 99% < 800 ms
  },
};

export function setup() {
  if (!BASE_URL) throw new Error("Set BASE_URL (repository variable API_URL)");
}

export default function () {
  const res = http.get(`${BASE_URL}/api/tariff`, { tags: { endpoint: "tariff" } });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "has 48 slots": (r) => r.status === 200 && r.json("slots").length === 48,
  });
  sleep(0.5);
}
