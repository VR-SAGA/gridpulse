// Command gridpulse-api is a small demo service that runs on Cloud Run.
//
// It serves a synthetic half-hourly energy tariff so there is something
// realistic to measure. Faults can be injected through environment
// variables, which lets the SLOs, burn-rate alerts and incident flow be
// exercised on demand (see .github/workflows/chaos.yml).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// Chaos holds fault-injection settings read from the environment.
type Chaos struct {
	ErrorRate float64       // 0..1 share of /api requests that return 503
	Latency   time.Duration // extra delay added to every /api request
}

// ChaosFromEnv reads CHAOS_ERROR_RATE and CHAOS_LATENCY_MS.
// Invalid or out-of-range values are clamped to safe defaults.
func ChaosFromEnv() Chaos {
	c := Chaos{}
	if v, err := strconv.ParseFloat(os.Getenv("CHAOS_ERROR_RATE"), 64); err == nil {
		c.ErrorRate = math.Max(0, math.Min(1, v))
	}
	if v, err := strconv.Atoi(os.Getenv("CHAOS_LATENCY_MS")); err == nil && v > 0 {
		c.Latency = time.Duration(min(v, 30000)) * time.Millisecond
	}
	return c
}

// TariffSlot is one half-hour price point.
type TariffSlot struct {
	From        time.Time `json:"from"`
	To          time.Time `json:"to"`
	PencePerKWh float64   `json:"pence_per_kwh"`
}

// Tariff builds 48 synthetic half-hour slots starting at the current slot.
// Prices follow a daily curve: cheap overnight, expensive at the 16:00-19:00 peak.
func Tariff(now time.Time) []TariffSlot {
	start := now.UTC().Truncate(30 * time.Minute)
	slots := make([]TariffSlot, 0, 48)
	for i := range 48 {
		from := start.Add(time.Duration(i) * 30 * time.Minute)
		h := float64(from.Hour()) + float64(from.Minute())/60
		price := 18 + 7*math.Sin((h-10)/24*2*math.Pi)
		if h >= 16 && h < 19 {
			price += 12
		}
		slots = append(slots, TariffSlot{
			From:        from,
			To:          from.Add(30 * time.Minute),
			PencePerKWh: math.Round(price*100) / 100,
		})
	}
	return slots
}

// Server wires handlers together.
type Server struct {
	Chaos Chaos
	Rand  func() float64
	Sleep func(context.Context, time.Duration) error
	Log   *slog.Logger
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// NewServer returns a Server with production defaults.
func NewServer(c Chaos, log *slog.Logger) *Server {
	return &Server{Chaos: c, Rand: rand.Float64, Sleep: sleepCtx, Log: log}
}

// Routes returns the HTTP handler.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/tariff", s.chaos(s.handleTariff))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"service": "gridpulse-api",
			"docs":    "https://github.com/VR-SAGA/gridpulse",
		})
	})
	return s.logRequests(mux)
}

func (s *Server) handleTariff(w http.ResponseWriter, r *http.Request) {
	// Simulate a little real work (a DB or pricing-engine call).
	_ = s.Sleep(r.Context(), time.Duration(15+s.Rand()*35)*time.Millisecond)
	writeJSON(w, http.StatusOK, map[string]any{
		"region": "GB",
		"unit":   "p/kWh",
		"slots":  Tariff(time.Now()),
	})
}

// chaos wraps an /api handler with the configured fault injection.
func (s *Server) chaos(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Chaos.Latency > 0 {
			if err := s.Sleep(r.Context(), s.Chaos.Latency); err != nil {
				return // client went away
			}
		}
		if s.Chaos.ErrorRate > 0 && s.Rand() < s.Chaos.ErrorRate {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "injected fault"})
			return
		}
		next(w, r)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// logRequests emits one structured log line per request. Cloud Logging
// parses the JSON and maps "severity" and "httpRequest" automatically.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		level := slog.LevelInfo
		if rec.status >= 500 {
			level = slog.LevelError
		}
		s.Log.Log(r.Context(), level, "request",
			slog.Group("httpRequest",
				"requestMethod", r.Method,
				"requestUrl", r.URL.Path,
				"status", rec.status,
				"latency", time.Since(start).String(),
				"userAgent", r.UserAgent(),
			),
		)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// newLogger produces JSON logs with Cloud Logging's field names.
func newLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.LevelKey:
				a.Key = "severity"
			case slog.MessageKey:
				a.Key = "message"
			}
			return a
		},
	}))
}

func main() {
	log := newLogger()
	chaos := ChaosFromEnv()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           NewServer(chaos, log).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("starting", "port", port, "chaos_error_rate", chaos.ErrorRate, "chaos_latency", chaos.Latency.String())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	// Cloud Run sends SIGTERM and allows 10s before SIGKILL.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	log.Info("stopped")
}
