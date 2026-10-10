# Local verification — 2026-10-10

Base: `727bc2eaddca853c0fa22cebac706fa9b7d0ae92` (13 commits). Local verification was completed in a new checkout before branch publication. No deployment was performed. No repository AGENTS.md or .agents instructions were present.

Changes are prepared on branch `release-hardening`. The existing commit author, Ilia Yasau <61440105+iliayasau@users.noreply.github.com>, was verified against the connected GitHub account iliayasau (ID 61440105). Commit identity is supplied per command; global Git configuration and credentials are unchanged.

Environment: Windows amd64, Node.js 24.19.0, npm 12.2.0, Go 1.27.2, Chromium 153.0.8010.12 / Playwright 1.63.0. Tools and caches were installed in the task workspace, outside the repository.

| Check | Result |
| --- | --- |
| `gofmt -l cmd internal` | Passed; no files listed |
| `go test -count=1 ./cmd/... ./internal/...` | Passed; 15 top-level application tests, including OIDC and hardening subtests |
| `go vet ./cmd/... ./internal/...` | Passed |
| `go test -race ./cmd/... ./internal/...` | Blocked locally; enabling CGO reports `C compiler "gcc" not found` |
| `npm ci` / npm dependency audit | Passed; 127 packages audited, zero vulnerabilities |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Playwright suite | 17 passed, including five new lifecycle regressions |
| `govulncheck` v1.8.0 on Go 1.27.2 | Passed; no vulnerabilities found |
| Git history and working-source secret scan | No matches for the checked patterns; see scope below |
| `git diff --check` | Passed |

The initial Go 1.27.1 scan reported 12 reachable standard-library vulnerabilities, all fixed in Go 1.27.2. The minimum version in go.mod and documentation was raised accordingly; the existing CI reads go.mod.

The secret scan examined every unique blob reachable from all 13 baseline commits (82 blobs), commit messages and nonignored working source files. Checks covered private-key blocks, common provider-token formats, JWTs, credential-bearing HTTP URLs, long literal credential assignments and sensitive filenames. Binary files were excluded from text matching. No secret values were printed. This heuristic check is not a guarantee that no secret exists, and should be complemented by the owner's chosen scanning service before publication.

Browser tests use fake media. Call/recovery tests run against the real local Go server and OIDC fixture; the five lifecycle cases deliberately control HTTP and browser APIs to test delayed permission/negotiation, socket close/reset and queue overflow. They do not establish real-provider, real-device, HTTPS or cross-network TURN readiness.

These local results do not include Linux race execution; consult the exact commit's GitHub Actions checks for that result. The owner authorized publication of this branch to the existing private repository and its CI run. A project license, private security-reporting channel, public release and deployment acceptance remain owner decisions; see [release checklist](release.md).
