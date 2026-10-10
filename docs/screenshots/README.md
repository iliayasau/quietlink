# Demo screenshots

Captured on 10 October 2026 from the actual QuietLink interface in Chromium:

- `call-desktop.png`: 1440px viewport.
- `call-tablet.png`: 768px viewport.
- `call-mobile.png`: 390px viewport, full page.

These are **synthetic demo participants**, entirely fictional adults generated
with OpenAI imagegen. Avery and Jordan are local test identities, not real users.
The source PNGs live in [../demo-media](../demo-media/README.md).

Two isolated browser contexts sign in through the local OIDC fixture, request
and approve admission, and exchange media through the real Go signaling service
and browser WebRTC implementation. A test-only `getUserMedia` replacement
streams each static portrait from a canvas with a silent audio track. It never
opens the user's camera or microphone. Jordan is depicted mid-sentence and Avery
is depicted laughing; the portraits remain static and contain no speech audio.

The interface is a browser screenshot, not a drawn UI or a photo montage.
The connected state demonstrates a local automated call only: it does not
demonstrate two real people, real cameras, separate networks, or TURN traversal.
No production authentication, security configuration, or application code was changed.

## Reproduce

With the repository's documented Go/Node requirements and Chromium installed:

```sh
npm ci
npm run build
npx playwright install chromium
npm run screenshots
```

Set `GO_BIN` if Go is not on PATH. The dedicated configuration
`tests/docs.config.ts` starts and stops local fixtures and runs
`tests/docs-capture.spec.ts`. It verifies both participants are connected,
received video has reached 1280px width, both previews are visible, and no
horizontal overflow occurs at any capture width. Waits allow WebRTC's encoder
to reach a readable resolution before capture.

Regular E2E tests exclude this scenario and write their own screenshots to
Playwright's test output. Only the explicit screenshot command updates these files.
