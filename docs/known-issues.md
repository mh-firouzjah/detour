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


## Operational limits, mitigations, and open questions

Reviewed: 2026-10-12. This section deliberately records limitations even where a mitigation exists. A mitigation is not a guarantee that the underlying runtime or network issue cannot recur.

### WebSocket ingress and memory

- **Platform limit:** Workers receive complete WebSocket messages, with a maximum incoming message size of 32 MiB (33,554,432 bytes). A message larger than the platform limit is automatically closed with WebSocket code `1009`. See [Cloudflare WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/).
- **Shared isolate memory:** the JavaScript and WebAssembly memory limit is 128 MB per isolate, not per request. A single isolate can process concurrent requests. Cloudflare documents that it attempts to let in-flight requests complete and creates a fresh isolate for subsequent requests after an isolate exceeds the limit; during extreme load, incoming requests may be cancelled. Exceeded memory/CPU can be surfaced as error `1102`. This does not mean Cloudflare will always close only the single connection that caused the pressure. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Error 1102](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/).
- **Application queue bound:** `MAX_QUEUED_INCOMING_BYTES` is currently 32 MiB. The custom queue checks queued message payload bytes and closes an overloaded connection with code `1013`; it does not measure all memory associated with a connection or isolate. A message delivered directly to a pending stream read and the chunk currently being processed are outside the custom array queue's byte counter. The runtime has already assembled the incoming WebSocket message before the `message` callback can reject it.
- **Backpressure gap:** `WritableStream` and awaited TCP writes provide application-level flow control toward the TCP destination, but Cloudflare's standard WebSocket API does not provide a way for this adapter to pause network-level ingress until its JavaScript queue drains. `WebSocket.send()` has no drain promise here, and `bufferedAmount` is not exposed. The [workerd `bufferedAmount`/backpressure issue #988](https://github.com/cloudflare/workerd/issues/988) was still open when reviewed on 2026-10-12.
- **Current decision:** keep the existing queue policy for now; do not claim that the queue limit is a strict per-connection or per-isolate memory ceiling. Do not reduce it solely on theoretical grounds before measuring real clients and concurrent sessions. Revisit if production metrics show overflow, memory error `1102`, unexpected close code `1013`, or memory growth with concurrency. Potential future options include a smaller measured queue cap, maximum queued-message count, or a transport with true receive backpressure, but none of these can make the runtime's pre-callback message allocation disappear.

### TCP connection-opening timeout

- **Mitigation added in code:** the default TCP open deadline is 3,000 ms. It applies only until Cloudflare's TCP `socket.opened` promise resolves. If the connection does not open in time, the socket is closed and the opening promise rejects; the socket close wrapper is idempotent. `TCP_CONNECT_TIMEOUT_MS`, when supplied as an environment value between 500 and 10,000 milliseconds inclusive, overrides the default. Missing, blank, or invalid values fall back to 3,000 ms.
- **Not an idle timeout:** once TCP opens, the deadline is cleared. No 2–3 second timeout is applied to an established tunnel or a quiet byte stream, because legitimate connections may temporarily have no payload. A broader handshake or idle timeout remains a separate decision and should be based on observed stuck sessions, not assumed latency.
- **Runtime API:** Cloudflare documents `socket.opened` as resolving when the TCP connection is established and rejecting on connection error; `socket.close()` forcibly closes both readable and writable streams. See [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

### Memory limit, cancellation, and account enforcement

- The platform's handling of memory pressure and the app's custom queue overflow are different mechanisms. The app currently reacts to custom queue overflow by closing the affected WebSocket, but memory exhaustion can affect any request sharing the isolate and may show up as `1102`.
- Cloudflare's Developer Platform terms allow Cloudflare to temporarily limit requests if they create an undue burden on the network and allow access limits/suspension for suspected agreement violations. The public documentation does **not** define a deterministic rule that crossing the 128 MB isolate limit a fixed number of times automatically bans an account. Therefore neither “Cloudflare will always clean up this connection safely” nor “a memory overage automatically bans the account” should be assumed. See [Developer Platform Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-developer-platform/).
- Operational response: monitor Workers invocation outcomes, logs, queue-overflow close codes, request volume, and memory/CPU errors. Do not create artificial high-load tests on the production account merely to find a limit; use local tests and small, controlled production checks.

### Network-path and ECH uncertainty

- There is no general rule that client-to-Worker throughput from Iran is always slower than Worker-to-destination throughput. These are different network paths and the relative throughput/latency depends on ISP, route, peering, destination, congestion, and protocol. Measure them separately; do not use the size of Cloudflare's network to infer a universal speed ratio.
- As of 2026-10-11, W3Techs estimated Cloudflare was used by about 26.8% of all websites it measures and held about 85.5% of the measured reverse-proxy-service market. These are website-usage statistics, not a measurement that Cloudflare carries more than half of all Internet traffic. See [W3Techs reverse proxy statistics](https://w3techs.com/technologies/overview/proxy).
- The observed difference between `172.67.176.68` and `104.21.96.90` is evidence of path/ISP-dependent reachability in the reported tests, not evidence that either IP should be pinned. Cloudflare front-door IPs can be shared anycast addresses and should not be hardcoded as durable Worker endpoints. Re-test by hostname, IP family, ISP, and time when diagnosing this symptom.
- ECH is configured and negotiated on the client-to-Cloudflare TLS leg; it is not a switch implemented inside the Worker. It can protect the inner SNI but does not hide the destination IP or repair every IP/route/connectivity problem. BPB documents ECH as unstable in Iran and notes that the shared outer name can itself be blocked; treat ECH as a client profile option to measure, not as a guaranteed fix. See [BPB VLESS/Trojan configuration notes](https://github.com/bia-pain-bache/BPB-Worker-Panel/blob/main/docs/en/docs/configuration/vless-trojan.md).
- A reproducible local `workerd` WebSocket error was previously observed after a `101 Switching Protocols` response, including in a minimal Worker. Real SOCKS5, VLESS, and Trojan HTTP transfers succeeded despite the local diagnostic in prior tests. This is documented as a local-runtime issue; production behavior has not been proven identical and should be checked separately.

### Verification status

- Automated checks last reported 80 passing tests across 15 files after the TCP connection-opening timeout change.
- Local independent client tests have also succeeded: sing-box 1.14.2 completed five HTTP requests over VLESS and five over Trojan, each returning `HTTP=200` and 577 bytes; SOCKS5 previously completed ten HTTP requests via GOST. These verify local interoperability and real TCP relays, not deployment readiness under production concurrency or memory pressure.
- Resource behavior still needs measured concurrency/throughput tests, and production observability needs review. Until those are complete, SOCKS5, VLESS, and Trojan should be described as locally tested, not fully production-certified.
