package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testServer(c Chaos, roll float64) (*Server, *time.Duration) {
	slept := new(time.Duration)
	return &Server{
		Chaos: c,
		Rand:  func() float64 { return roll },
		Sleep: func(_ context.Context, d time.Duration) error { *slept += d; return nil },
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, slept
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestHealthz(t *testing.T) {
	s, _ := testServer(Chaos{ErrorRate: 1}, 0)
	if rec := get(t, s.Routes(), "/healthz"); rec.Code != http.StatusOK {
		t.Fatalf("healthz must ignore chaos, got %d", rec.Code)
	}
}

func TestTariffHealthy(t *testing.T) {
	s, _ := testServer(Chaos{}, 0.5)
	rec := get(t, s.Routes(), "/api/tariff")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var body struct {
		Slots []TariffSlot `json:"slots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Slots) != 48 {
		t.Fatalf("want 48 slots, got %d", len(body.Slots))
	}
}

func TestChaosErrorRate(t *testing.T) {
	cases := []struct {
		name string
		rate float64
		roll float64
		want int
	}{
		{"no chaos", 0, 0.0, http.StatusOK},
		{"roll below rate fails", 0.3, 0.1, http.StatusServiceUnavailable},
		{"roll above rate passes", 0.3, 0.9, http.StatusOK},
		{"rate 1 always fails", 1, 0.999, http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := testServer(Chaos{ErrorRate: tc.rate}, tc.roll)
			if rec := get(t, s.Routes(), "/api/tariff"); rec.Code != tc.want {
				t.Fatalf("want %d, got %d", tc.want, rec.Code)
			}
		})
	}
}

func TestChaosLatency(t *testing.T) {
	s, slept := testServer(Chaos{Latency: 900 * time.Millisecond}, 0.5)
	get(t, s.Routes(), "/api/tariff")
	if *slept < 900*time.Millisecond {
		t.Fatalf("expected injected latency, slept %v", *slept)
	}
}

func TestChaosFromEnvClamps(t *testing.T) {
	t.Setenv("CHAOS_ERROR_RATE", "7")
	t.Setenv("CHAOS_LATENCY_MS", "-5")
	c := ChaosFromEnv()
	if c.ErrorRate != 1 || c.Latency != 0 {
		t.Fatalf("unexpected %+v", c)
	}
}

func TestTariffPeakIsMoreExpensive(t *testing.T) {
	day := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	slots := Tariff(day)
	night, peak := slots[6].PencePerKWh, slots[34].PencePerKWh // 03:00 vs 17:00
	if peak <= night {
		t.Fatalf("peak %.2f should exceed night %.2f", peak, night)
	}
}
