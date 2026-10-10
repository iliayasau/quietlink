# Release checklist

## Source publication

- Run the verification commands in README on the exact release commit; Linux CI must pass the race detector.
- Review tracked files and all Git history for credentials; use redacted reports. Ignore rules do not remove prior commits.
- Run `npm audit` and `govulncheck ./cmd/... ./internal/...`; record tool versions and unresolved findings.
- The owner must choose a project license and review dependency license obligations. No license has been selected here.
- The owner must choose a private security-reporting channel before public release. Do not put credentials, private signaling data or exploit details in public issues.
- Publishing commits, changing repository visibility and configuring GitHub security features require separate owner authorization.

## Deployment acceptance (not established by source tests)

- Configure and verify a real OIDC provider, exact redirect URI, issuer and signing algorithms.
- Verify HTTPS, host-prefixed cookies, proxy WebSocket support, redacted logs and edge limits. Test the shared backend login budget described in operations.
- Provide and verify a quota-controlled TURN service if required; credentials and paid resources need operator decisions.
- Test real camera/microphone devices and two separate networks, forced relay, and TCP/TLS fallback.
- Perform manual accessibility checks and review operational monitoring and incident handling.

Local OIDC fixtures and fake media demonstrate application behavior, not real-provider or cross-network deployment readiness.
