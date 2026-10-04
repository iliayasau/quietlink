# QuietLink

Private, invitation-only video calls for two people. Go handles identity, room access and signaling; browsers exchange media using WebRTC.

## Project status

In development. Verification results and runnable setup will be recorded as implementation progresses. No public deployment or real identity-provider configuration is included.

## Design

- One configured OIDC issuer; authorization code flow with PKCE, state and nonce.
- Opaque server-side sessions, same-origin requests and CSRF checks.
- Expiring, single-use invitations and explicit host approval; at most two admitted identities.
- Camera preview, microphone and camera controls, connection feedback and hangup.
- Standard browser DTLS-SRTP media encryption. Signaling and the web origin remain trusted. OIDC login does not independently bind identities to media fingerprints.
- Optional TURN configuration for networks that cannot connect directly.

No recording, group calls, SFU or custom cryptography. The Go server is not a media endpoint.
