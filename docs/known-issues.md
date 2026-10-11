# Known Issues

## Local Wrangler `dev`: WebSocket runtime error after upgrade

**Status:** Reproduced locally on 2026-10-11. Upstream issue #7312 was open when checked.
**Scope:** The observed failure is in local `wrangler dev`. Production behavior has not been established by this reproduction.

### Project reproduction

Environment:
- Wrangler: `4.149.0`
- Project compatibility date: `2026-09-07`
- Endpoint: authenticated SOCKS5 over WebSocket

Observed behavior:
- The Worker returns `101 Switching Protocols`.
- The local runtime logs either `Network connection lost` or the request `hung` error.
- A minimal Worker containing only `WebSocketPair`, `server.accept()`, and the `101` response reproduces `Network connection lost` while the client keeps the socket open for 10 seconds.
- The minimal client then closes normally with code `1000`.
- Ten independent GOST -> Worker -> `example.com:80` requests all returned `HTTP 200` and 577 bytes, although the runtime `hung` log continued to occur.

This establishes that the log can coexist with successful requests in the tested local environment. It does not establish that the error is harmless in production.

### Related upstream reports

- [workerd #7312](https://github.com/cloudflare/workerd/issues/7312) — A minimal WebSocket-only Worker intermittently logs `Network connection lost` or the `hung` error after returning `101`. The issue was open with no linked fix when checked on 2026-10-11.
- [workerd #5290](https://github.com/cloudflare/workerd/issues/5290) — A separate WebSocket close-handshake issue involving client-initiated close and `Network connection lost`. Do not treat it as the same failure as #7312.
- [workers-sdk #15452](https://github.com/cloudflare/workers-sdk/issues/15452) — A different `wrangler dev` failure involving an open WebSocket alongside an ordinary HTTP request roughly every five seconds. That cadence is not part of the minimal idle-socket reproduction above.

### Relevant documentation

Cloudflare's [WebSockets documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/) states that `accept({ allowHalfOpen: true })` leaves the socket in `CLOSING` after receiving a Close frame, so the application must explicitly complete the close handshake.

The project's WebSocket transport handles that close path. This behavior is separate from the immediate post-upgrade runtime error reproduced with a minimal Worker.

### Current handling

- Do not add `ctx.waitUntil()` as a speculative fix for the long-lived tunnel.
- Do not suppress or catch the runtime error merely to hide the log.
- Do not attribute the failure to SOCKS5, TCP forwarding, or application-level stream handling without new evidence.
- Re-test the minimal reproduction after Wrangler/workerd updates and record whether the behavior changes.
