import { dialTcp, resolveTcpConnectTimeoutMs, type TcpDialer } from './dialers/tcp';
import { areValidSocks5Credentials, createSocks5SessionHandler } from './protocols/socks5-session';
import { createTrojanSessionHandler } from './protocols/trojan-session';
import { createVlessSessionHandler } from './protocols/vless-session';
import { isValidVlessUuid } from './protocols/vless';
import { createTunnelWorker, MAX_QUEUED_INCOMING_BYTES, type TunnelWorkerEnvironment } from './worker';

const tunnelWorker = createTunnelWorker({
	maxQueuedIncomingBytes: MAX_QUEUED_INCOMING_BYTES,
	sessionHandlerFactory(env, pathname) {
		const timeoutMs = resolveTcpConnectTimeoutMs(env.TCP_CONNECT_TIMEOUT_MS);
		const dial: TcpDialer = (hostname, port) => dialTcp(hostname, port, timeoutMs);

		if (pathname === env.TUNNEL_PATH) {
			const username = env.SOCKS5_USERNAME;
			const password = env.SOCKS5_PASSWORD;

			if (username === undefined || password === undefined || !areValidSocks5Credentials(username, password)) {
				return undefined;
			}

			return createSocks5SessionHandler(username, password, dial);
		}

		if (pathname === env.VLESS_PATH) {
			const uuid = env.VLESS_UUID;

			if (!isValidVlessUuid(uuid)) {
				return undefined;
			}

			return createVlessSessionHandler(uuid, dial);
		}

		if (pathname === env.TROJAN_PATH) {
			const password = env.TROJAN_PASSWORD;

			if (password === undefined || password.length === 0) {
				return undefined;
			}

			return createTrojanSessionHandler(password, dial);
		}

		return undefined;
	},
});

export default {
	fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const bindings = env as unknown as Record<string, string | undefined>;
		const mappedEnvironment: TunnelWorkerEnvironment = {
			TUNNEL_PATH: bindings.A0 ?? bindings.TUNNEL_PATH,
			SOCKS5_USERNAME: bindings.B1 ?? bindings.SOCKS5_USERNAME,
			SOCKS5_PASSWORD: bindings.B2 ?? bindings.SOCKS5_PASSWORD,
			VLESS_PATH: bindings.C1 ?? bindings.VLESS_PATH,
			VLESS_UUID: bindings.C2 ?? bindings.VLESS_UUID,
			TROJAN_PATH: bindings.D1 ?? bindings.TROJAN_PATH,
			TROJAN_PASSWORD: bindings.D2 ?? bindings.TROJAN_PASSWORD,
			TCP_CONNECT_TIMEOUT_MS: bindings.E1 ?? bindings.TCP_CONNECT_TIMEOUT_MS,
		};
		return tunnelWorker.fetch(request, mappedEnvironment);
	},
} satisfies ExportedHandler<Env>;
