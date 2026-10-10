# Architecture decisions

The app is served from one origin. A Go net/http server owns OIDC authentication, in-memory sessions, rooms and WebSocket signaling. React and TypeScript own local device preview and the RTCPeerConnection lifecycle.

Identity is the pair (issuer, subject), never email. OAuth transactions last five minutes and are bound to a separate HttpOnly browser cookie. Successful callbacks consume the transaction before exchanging the code; state, PKCE, verified ID token and nonce are all required. Sessions expire after eight hours. Tokens are discarded after login.

Room mutation and admission occur under one mutex. Each room has one host and at most one guest. Invitations expire after ten minutes and are consumed on a join request. Approval is separate from requesting entry; a pending guest cannot signal. Rejecting or leaving requires a new invitation. A host leaving closes the room. Room lifetime is two hours and process restart clears all state.

The authenticated session snapshot includes only that session's current room, including pending admission. The browser uses this authoritative snapshot on refresh and after uncertain create/join outcomes. Lost responses do not require replaying invitation tokens or bypassing approval. A host whose invitation response was lost can explicitly issue a fresh invitation; plaintext tokens are not retained for recovery. Transport failures and 5xx responses retain the browser's saved room reference and offer a retry; only confirmed session expiry, room termination or an authenticated empty snapshot clears it.

Signaling is authenticated at handshake and on every message. Exact Origin checks precede upgrades. A bounded outgoing queue, message size limits, per-connection rate limit and timed writes prevent unbounded buffering. Messages are limited to offer, answer, candidate and ready. SDP and tokens are never logged.

The host initiates offers. A guest sends ready after installing handlers. Reconnecting closes the old connection and repeats negotiation. There is one active signaling socket per session per room; a duplicate connection is rejected so another tab cannot repeatedly interrupt a healthy call. Session revocation closes matching sockets and removes room access.

Client signaling uses a bounded per-socket queue and checks both socket generation and negotiation epoch after asynchronous work. A reset immediately invalidates old work and clears queued messages, even during a pending browser negotiation call. A closed socket cannot create a later peer through a queued offer. Camera permission requests carry a separate generation so room/session cleanup also stops streams that resolve after cleanup.

Within each socket, a reset replaces the negotiation queue and its processing flag. New work does not await the closed peer's browser promises, which may never settle. Old drains capture their own queue; their finally blocks cannot change the new epoch's processing state.

The development identity provider is a separate loopback-only process. It exercises discovery, authorization, code exchange, PKCE and signed ID tokens. It offers named test identities, not actual account authentication, and cannot be used with production configuration.

## Primary references

- https://pkg.go.dev/github.com/coder/websocket
- https://pkg.go.dev/golang.org/x/oauth2
- https://pkg.go.dev/github.com/coreos/go-oidc/v3/oidc
- https://www.rfc-editor.org/rfc/rfc9700
- https://www.rfc-editor.org/rfc/rfc8827
- https://webrtc.org/getting-started/peer-connections
- https://webrtc.org/getting-started/turn-server
