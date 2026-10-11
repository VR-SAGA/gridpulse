# Small static binary on distroless: about 10 MB, well inside the
# 0.5 GB Artifact Registry free tier.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gridpulse-api .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/gridpulse-api /gridpulse-api
USER nonroot:nonroot
ENTRYPOINT ["/gridpulse-api"]
