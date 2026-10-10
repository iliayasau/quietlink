# Trust model

## Identity and access

One configured OIDC issuer authenticates users through authorization code flow with PKCE S256. Signed ID tokens require matching issuer, audience, expiry and nonce. Identity is the pair (issuer, subject), never email. Display names are not necessarily unique; confirm the expected guest before admission.

Login transactions last five minutes, are bound to an independent HttpOnly browser cookie, and are consumed once. Server-side sessions use random 256-bit identifiers, last eight hours and discard upstream tokens after login. Session cookies are HttpOnly, SameSite=Lax and Secure on HTTPS origins. Logout revokes the local session and room access, not the upstream provider session.

HTTPS names are `__Host-ql_session` and `__Host-ql_login`, with Path=/ and no Domain. Loopback HTTP development keeps `ql_session` and `ql_login`. Only the name appropriate to the configured origin is accepted; duplicate same-name cookies are rejected rather than selecting the first. This hardens against sibling-domain cookie injection in supporting browsers. Existing unprefixed HTTPS cookies no longer authenticate after an upgrade; users must sign in again.

Mutations require the exact configured Origin and session CSRF token. WebSockets require the exact Origin, authentication and admitted membership; every incoming message rechecks membership and expiry. Only the host can approve guests. Invitation tokens have 256 bits of randomness; only their SHA-256 hashes are stored. Links place tokens in URL fragments, remove them from the address bar on arrival and preserve them in sessionStorage during login. Invitations expire in ten minutes and are consumed atomically on a join request. Rejected guests need a new invitation. Admission and the two-person limit share one mutex.

## Media and trust boundaries

Browser WebRTC uses standard DTLS-SRTP encryption between media endpoints, including when TURN relays packets. Go exchanges signaling and is not a media endpoint. The web origin, delivered JavaScript, signaling service and identity provider remain trusted. OIDC login does not independently bind identities to media fingerprints; this is not an independently verified end-to-end identity system.

Peers may learn each other's IP addresses through ICE. TURN operators see connection metadata and traffic volume. Participants can record through external tools although this app offers no recording feature.

## Resource controls and operations

Sessions, login transactions and rooms have capacity bounds. Signaling has a 64 KiB read limit, schema/role checks, 80 messages per second per socket, 32 queued messages, five-second writes and heartbeat timeouts. Duplicate live sockets for the same session and room are rejected. Expired state is cleaned on requests and every 15 seconds. These controls are not a distributed denial-of-service defense; internet deployments need proxy-level controls.

Login starts have a fixed-window limit of 60 per five minutes per transport IPv4 address or IPv6 /64, with at most 2048 source counters and 1000 outstanding transactions. No forwarding headers influence the quota. A full counter map rejects new sources until entries expire. A NAT or reverse proxy shares a quota; enforce additional client limits at the trusted edge. There are at most 2000 sessions globally and five per verified (issuer, subject), with same-browser replacement allowed at capacity, and at most 500 rooms globally. One identity can host, join or wait in only one room across all its sessions. Room access and recovery remain session-scoped; another session does not inherit membership.

The browser accepts at most 32 pending signaling messages plus one in-flight operation per socket and caps each message at 64 KiB of text. Socket close, effect cleanup and newer negotiation epochs invalidate queued and awaited work. Overflow closes signaling and requires an explicit retry. Ending a room/session or leaving invalidates pending camera requests; any stream returned later has all its tracks stopped.

Application logs omit tokens, SDP and invitation links. Reverse proxies must omit callback query strings, cookies and request bodies from logs. Security headers restrict framing, script sources, referrers and device permissions.

This single-process MVP uses in-memory state. Restart ends sessions and room access. Run exactly one instance. No persistent account records, call history, recording, group calling or account recovery are provided. Room lifetime is two hours. Use Leave before closing a tab: an abrupt closure retains a reservation until expiry, allowing reconnection. Normal clients close the peer connection on signaling loss and use bounded reconnect attempts; local preview tracks remain active until Leave, sign-out or confirmed room/session termination. Suspended or hostile clients are outside lifecycle guarantees.

The standalone development issuer binds to 127.0.0.1 and requires APP_ENV=development. Named test identities are not real authentication. Production rejects its reserved client ID. Never expose this process or use it as a production provider.

Local fake-media tests do not verify real devices, a real identity provider or separate-network TURN connectivity. Those require independent checks before deployment.
