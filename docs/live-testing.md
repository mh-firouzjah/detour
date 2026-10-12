# Live integration test

`npm run check` stays deterministic and local. The live test is an explicit, opt-in integration test against an already deployed Worker. It does not deploy, edit source files, or upload `.dev.vars`.

## Requirements

- `curl`
- `sing-box` 1.14.x or newer with ECH support
- `gost` 3.x (optional; it is a non-ECH control)
- `.dev.vars` with the local semantic keys below. The runner also accepts the short keys used by the deployed Worker.

The runner reads secrets and paths locally but never prints their values:

| Local name                      | Meaning                    |
| ------------------------------- | -------------------------- |
| `TUNNEL_PATH` / `A0`            | SOCKS5 path                |
| `SOCKS5_USERNAME` / `B1`        | SOCKS5 username            |
| `SOCKS5_PASSWORD` / `B2`        | SOCKS5 password            |
| `VLESS_PATH` / `C1`             | VLESS path                 |
| `VLESS_UUID` / `C2`             | VLESS credential           |
| `TROJAN_PATH` / `D1`            | Trojan path                |
| `TROJAN_PASSWORD` / `D2`        | Trojan credential          |
| `TCP_CONNECT_TIMEOUT_MS` / `E1` | TCP open timeout; optional |

## Run against the target network

```bash
npm run test:live
```

By default, the runner uses the current `detour.mh-firouzjah.workers.dev` deployment. Override the origin when testing a renamed or separate deployment:

```bash
DETOUR_TEST_URL='https://your-worker.workers.dev' npm run test:live
```

The runner discovers current IPv4 answers from DNS and also checks previously observed candidates. An explicit candidate list is preferred for reproducible comparisons:

```bash
DETOUR_TEST_IPS='104.21.96.90,172.67.176.68' \
DETOUR_TEST_MAX_IPS=2 npm run test:live
```

Alternatively, `DETOUR_TEST_IP_FILE=/path/to/result.csv` accepts CloudflareSpeedTest-style CSV where the first column is an IPv4 address. `DETOUR_TEST_MAX_IPS` controls how many responsive IPs receive the full protocol matrix. Every candidate is first checked with the real Worker hostname as TLS SNI and HTTP `Host`; a raw TCP connection is not considered sufficient.

## What it tests

1. Root HTTPS response (`200`) and protocol-path preflight (`426` when no WebSocket upgrade is sent).
2. VLESS and Trojan using sing-box with ECH. Each must download the vendor test objects: `1Mb.dat` (1 MiB), `10Mb.dat` (10 MiB), and complete three reconnect downloads. Redirects are followed but limited to HTTPS, and final status plus received bytes are checked.
3. VLESS and Trojan without ECH, plus GOST's SOCKS5 client, as diagnostic controls. These controls are reported separately because client-to-Worker routing can differ by ISP and IP.
4. One non-gating request to a Cloudflare-hosted destination, to diagnose Worker egress restrictions separately from ingress.

The sing-box ECH config explicitly sets the `local` DNS server with `prefer_go: true`. This avoids the systemd-resolved D-Bus path implicated in sing-box 1.14.2 issue [#4576](https://github.com/SagerNet/sing-box/issues/4576); that upstream issue was closed with a fix on 27 September 2026. The runner's output still determines whether DNS/ECH works on the machine under test.

All generated client configs, response headers, and client logs live in one mode-0700 temporary directory directly under the repository root, named `.detour-live-test-*`. It is removed at exit, including ordinary failures and Ctrl-C. Set `DETOUR_KEEP_TEST_ARTIFACTS=1` only when debugging; retained files can contain credentials or connection metadata and must not be committed or shared. A local `.git/info/exclude` entry ignores the directory if a run is forcibly interrupted.

## Interpretation

- Root `200` means the chosen ingress IP and hostname can reach the Worker; it does not prove protocol forwarding.
- Protocol-path `426` means routing recognizes the path; it does not prove authentication or TCP relay.
- A final `200` plus byte count confirms an actual download. A `301` alone does not.
- If ECH succeeds while no-ECH times out on the same IP, that is evidence of an ingress-path difference consistent with network filtering, not proof of the exact mechanism.
- If all ingress modes connect but a Cloudflare-fronted target fails, treat that as an egress result, not an ingress result.
- This is a single-run, single-network test; it is not a multi-hour stability guarantee.

## Known Cloudflare egress limit

Cloudflare's [TCP sockets documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) states that outbound TCP connections to IP ranges belonging to Cloudflare are blocked. ECH and additional Worker ingress IPs do not remove that restriction. A transparent TCP tunnel cannot reach every Cloudflare-fronted target through a direct Worker TCP socket; supporting such targets may require an independently reachable upstream relay or a separate HTTP-only implementation. An HTTP `fetch()` implementation is not a drop-in substitute for arbitrary TCP/TLS byte streams.
