# Architecture decisions

The app is served from one origin. A Go net/http server owns OIDC authentication, in-memory sessions, rooms and WebSocket signaling. React and TypeScript own local device preview and the RTCPeerConnection lifecycle.

Identity is the pair (issuer, subject), never email. OAuth transactions last five minutes and are bound to a separate HttpOnly browser cookie. Successful callbacks consume the transaction before exchanging the code; state, PKCE, verified ID token and nonce are all required. Sessions expire after eight hours. Tokens are discarded after login.

Room mutation and admission occur under one mutex. Each room has one host and at most one guest. Invitations expire after ten minutes and are consumed on a join request. Approval is separate from requesting entry; a pending guest cannot signal. Rejecting or leaving requires a new invitation. A host leaving closes the room. Room lifetime is two hours and process restart clears all state.

Signaling is authenticated at handshake and on every message. Exact Origin checks precede upgrades. A bounded outgoing queue, message size limits, per-connection rate limit and timed writes prevent unbounded buffering. Messages are limited to offer, answer, candidate and ready. SDP and tokens are never logged.

The host initiates offers. A guest sends ready after installing handlers. Reconnecting replaces the old connection, closes the old peer connection and repeats negotiation. There is one active signaling socket per identity per room. Session revocation closes matching sockets and removes room access.

The development identity provider is a separate loopback-only process. It exercises discovery, authorization, code exchange, PKCE and signed ID tokens. It offers named test identities, not actual account authentication, and cannot be used with production configuration.

## Primary references

- https://pkg.go.dev/github.com/coder/websocket
- https://pkg.go.dev/golang.org/x/oauth2
- https://pkg.go.dev/github.com/coreos/go-oidc/v3/oidc
- https://www.rfc-editor.org/rfc/rfc9700
- https://www.rfc-editor.org/rfc/rfc8827
- https://webrtc.org/getting-started/peer-connections
- https://webrtc.org/getting-started/turn-server
