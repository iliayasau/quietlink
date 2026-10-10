# Running QuietLink

## Local development

Install Go 1.27.2+ and Node.js 24+. From the repository root:

```sh
npm ci
npm run build
npm run dev
```

The launcher builds both Go binaries, starts the loopback test identity provider on port 9090 and serves QuietLink at **http://127.0.0.1:8080**. Set GO_BIN to an absolute Go executable path when Go is not on PATH. Stop with Ctrl+C. Environment variables are explicitly configured by the launcher; .env files are not loaded.

Use two separate browser profiles. Sign in as Avery and Jordan, enable devices, create a room as Avery, and open the invitation as Jordan. Request entry and accept it as the host. The preview is local before approval. Leaving stops local tracks; host departure closes the room. A guest departure frees the seat but requires a fresh invitation next time.

These are visibly labeled test identities, not real accounts. Use the exact 127.0.0.1 origin; localhost does not match the registered redirect. Do not expose these processes through a public tunnel.

## Checks

```sh
go mod tidy
go vet ./cmd/... ./internal/...
go test ./cmd/... ./internal/...
go test -race ./cmd/... ./internal/...
npm run lint
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

The race detector needs a supported C toolchain. Browser tests start the real Go server and local OIDC provider; keep 8080 and 9090 free. They use fake media devices. Generated traces may contain test signaling and are ignored by Git. UI_ONLY=1 with `npx playwright test tests/ui.spec.ts` runs frontend-only checks with an explicit test identity-response stub.

## Production configuration

Register an app with your existing OIDC provider. Set its callback to `https://your-host/auth/callback`, enable authorization code with PKCE S256, and allow `openid profile`. Configure APP_ENV=production, APP_ORIGIN (HTTPS, no trailing slash), OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET where required. Supported ID-token signatures are RS256 and ES256. Never commit secrets.

Build the frontend and run `go build -o bin/quietlink ./cmd/quietlink`. Run the resulting binary from the repository root so web/dist is available. Place the backend behind a trusted TLS reverse proxy supporting WebSocket upgrades and idle timeouts longer than the 20-second heartbeat. Restrict backend access to the proxy. LISTEN_ADDR defaults to 127.0.0.1:8080; set explicitly for containers. Run one instance. Do not use the development launcher or fixture in production.

Login throttling uses only the backend TCP peer (IPv4 address or IPv6 /64): 60 starts per five-minute window. All users behind the same proxy share that budget. Apply per-client rate limits at the edge using its verified connection metadata and assess this shared capacity before deployment. QuietLink does not trust X-Forwarded-For or Forwarded. HTTPS login/session cookies use the `__Host-` prefix; older unprefixed cookies require a fresh sign-in. Up to five sessions per OIDC identity are allowed, but only one can occupy a room at a time. Sign out of unused sessions or wait for their eight-hour expiry.

## Optional TURN

ICE_SERVERS accepts JSON RTCIceServer objects, for example:

```json
[
  {
    "urls": ["turns:turn.example.com:5349?transport=tcp"],
    "username": "operator-issued-user",
    "credential": "operator-issued-password"
  }
]
```

Configured credentials are delivered to authenticated browsers. Limit and rotate them, enforce relay quotas, and keep secrets out of source control. This MVP does not mint short-lived TURN credentials. No third-party STUN/TURN service is enabled by default; restricted networks may fail without one.

TURN consumes bandwidth and may incur charges. Hosting needs a public reachable address, configured listener ports (commonly UDP/TCP 3478 and TLS 5349), a UDP relay port range, and correct NAT mappings. Ordinary HTTP hosting is insufficient. Follow the [official coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) for authentication, certificates, quotas and restrictions. Never operate an unauthenticated open relay.

Before claiming cross-network support, test separate networks, temporarily force relay in a test build with `iceTransportPolicy: 'relay'`, and inspect the selected candidate pair in browser WebRTC diagnostics. Repeat with UDP blocked for TCP/TLS fallback. No operator-provided TURN server has been verified in this environment.
