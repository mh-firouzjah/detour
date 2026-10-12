# Peer-project review and production gates

Reviewed on 2026-10-12. These projects are references for design ideas and observed trade-offs. No source implementation is copied into detour.

## Relevant ideas from comparable projects

### BPB Worker Panel

Sources:

- <https://github.com/bia-pain-bache/BPB-Worker-Panel>
- <https://github.com/bia-pain-bache/BPB-Worker-Panel/blob/main/docs/en/docs/configuration/vless-trojan.md>
- <https://github.com/bia-pain-bache/BPB-Worker-Panel/blob/main/docs/en/docs/configuration/common.md>

BPB treats ingress selection as a set of alternatives: ECH, Fragment, custom domains/CDNs, clean IPs, and client-specific connection settings. It also exposes a separate `Proxy IP` setting for Cloudflare-fronted destinations and `Chain Proxy` for a stable upstream. Its documentation warns that the default ECH outer name can itself be blocked and that methods vary by ISP. The useful design idea is to measure alternate ingress paths, and to keep ingress-IP choice separate from destination egress.

### yonggekkk/Cloudflare-vless-trojan

Source: <https://github.com/yonggekkk/Cloudflare-vless-trojan>

The project's configuration covers alternate IP/domain candidates and modes such as ECH and ordinary TLS, plus a separate `proxyip` option. The useful idea is not a raw IP list alone, but a curated candidate list that is tested using the real Worker hostname for TLS and HTTP routing. Its upstream/ProxyIP mode must not be confused with the client ingress IP.

### 6Kmfi6HP/EDtunnel

Source: <https://github.com/6Kmfi6HP/EDtunnel>

EDtunnel exposes multiple proxy transports, ProxyIP, candidate rotation and fallback patterns. This motivates an optional upstream relay for destinations unreachable through the Worker directly. Whether a specific ProxyIP mode is suitable as a general relay must be established from its semantics, not inferred from the name.

### XIU2/CloudflareSpeedTest

Source: <https://github.com/XIU2/CloudflareSpeedTest>

It ranks Cloudflare IP candidates using delay and throughput. That can narrow a candidate set, but a speed-test result alone does not establish Worker reachability. detour still needs a real HTTPS check using the correct Worker SNI/Host, followed by a WebSocket exchange and a payload transfer.

## Separate failure domains

### Client to Worker (ingress)

Measurements from one Iranian ISP have shown different outcomes for different IPv4 candidates, and ECH has reached an HTTP response where non-ECH timed out. This is consistent with route/ISP filtering, but one run cannot identify the exact middlebox behavior. Test candidates with the real hostname for SNI, certificate validation and `Host`; keep measured results instead of assuming that an arbitrary Cloudflare IP is interchangeable.

### Worker to destination (egress)

Cloudflare blocks Worker TCP sockets to Cloudflare IP ranges, according to the official TCP sockets documentation: <https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>. This is independent of ECH and the chosen ingress IP. A transparent TCP tunnel cannot remove this restriction with more client-facing IPs. An optional non-Cloudflare upstream relay is a possible design but adds latency, cost, credentials and trust in the relay. A `fetch()`-based HTTP path is a different architecture and cannot carry arbitrary TCP/TLS byte streams.

### Runtime and protocol lifecycle

A root `200` and path preflight `426` test only ingress and route dispatch. End-to-end success needs protocol authentication, real target bytes, sustained transfer and reconnects. Keep live tests opt-in so ordinary checks do not depend on public hosts, external client binaries, or the ISP currently in use.

## Production gates

1. Local correctness: formatter, lint, typecheck and all deterministic tests pass.
2. Live ECH smoke: VLESS and Trojan both fetch the 1 MiB test object through the deployed Worker from the actual ISP.
3. Sustained transfer and reconnect: receive all 10 MiB and pass three independent reconnects for both protocols.
4. Route resilience: compare a curated set of IPv4/IPv6 candidates, with the same target URL, payload, SNI/Host and client version.
5. Destination coverage: check one ordinary destination and one Cloudflare-fronted destination. Record the documented egress limitation separately.
6. Stability: repeat tests at multiple times over several hours/days. One successful run is not evidence of daily reliability.
7. Peer benchmark: deploy a peer implementation independently and use the same ISP, IP candidates, target files, clients and duration. Compare success rate, time to first byte, throughput and reconnect rate rather than comparing generic IP ping alone.

## Current assessment

Observed live baseline, 2026-10-12, one ISP and one deployed Worker:

- Required ECH integration checks: 13 passed, 0 failed.
- VLESS ECH: 1 MiB download, 10 MiB download, and three reconnect downloads all returned final HTTP 200 with the expected byte counts. The 10 MiB transfer took 27.01 seconds.
- Trojan ECH: the same five checks passed. The 10 MiB transfer took 27.82 seconds.
- The large downloads are intentionally rate-limited to 512 KiB/s; these durations do not measure peak throughput.
- Ingress candidate 104.21.96.90 returned HTTP 200. Candidate 172.67.176.68 returned no HTTP response within the test timeout.
- All three protocol paths returned HTTP 426 when requested without a WebSocket upgrade.
- Non-ECH VLESS, non-ECH Trojan, and the GOST no-ECH control timed out on this network. This supports preferring ECH on the tested path, without proving the exact filtering mechanism.
- The Cloudflare-hosted destination diagnostic failed with a TLS EOF. Cloudflare documents outbound TCP socket restrictions to Cloudflare IP ranges; this is a separate egress coverage gap.

This is sufficient evidence for a limited secondary-path trial using ECH with VLESS or Trojan for destinations reachable through the Worker's direct TCP egress. It is not a multi-hour stability result, peak-speed measurement, or proof of broad destination coverage. No further deployment should occur until the diff is reviewed and the remaining egress limitation is addressed or explicitly accepted.
