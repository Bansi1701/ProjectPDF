# Phone handoff: implementation boundary

The sign page currently keeps the PDF and signature pad in the browser. The
“Send from phone” panel is a visual foundation only: it deliberately does not
create a QR code, pairing token, upload, or pretend transfer. A real handoff
needs a small signaling service and a browser-to-browser transport before the
UI can safely expose pairing.

## Required backend contract

1. `POST /v1/sign-pairings` creates a cryptographically random, single-use
   pairing id with a short expiry (for example, five minutes). Return only a
   human-safe code and the service's WebRTC signaling details. Never put PDF
   bytes or signature pixels in the QR payload.
2. `GET/POST /v1/sign-pairings/{id}/events` exchanges SDP offers/answers and
   ICE candidates. Authenticate both sides with a one-time capability token;
   rate-limit attempts and delete the record on expiry, completion, or cancel.
3. The browser uses a WebRTC `RTCDataChannel` for a small, encrypted signature
   gesture/PNG transfer. The service must not log or persist channel payloads.
   If direct connectivity fails, provide a configured TURN server over TLS;
   TURN is a relay and therefore must have bounded retention and access logs.
4. The receiving phone must explicitly approve the pairing and show the origin,
   expiry, and what is being received. The desktop must show connected,
   cancelled, expired, and failed states and allow either side to revoke the
   pairing.
5. Add abuse controls: origin allow-list/CORS, CSRF protection for cookie
   sessions (or strict bearer handling), per-IP and per-pairing limits,
   replay protection, and metrics that exclude document/signature content.

The frontend should continue to describe the PDF as local until the user
explicitly starts a handoff. A future implementation should be reviewed for
its data-retention policy and threat model before enabling the QR action.
