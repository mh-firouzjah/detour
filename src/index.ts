import { areValidSocks5Credentials, createSocks5SessionHandler } from './protocols/socks5-session';
import { createVlessSessionHandler } from './protocols/vless-session';
import { isValidVlessUuid } from './protocols/vless';
import { createTunnelWorker, MAX_QUEUED_INCOMING_BYTES, type TunnelWorkerEnvironment } from './worker';

const tunnelWorker = createTunnelWorker({
	maxQueuedIncomingBytes: MAX_QUEUED_INCOMING_BYTES,
	sessionHandlerFactory(env, pathname) {
		if (pathname === env.TUNNEL_PATH) {
			const username = env.SOCKS5_USERNAME;
			const password = env.SOCKS5_PASSWORD;

			if (username === undefined || password === undefined || !areValidSocks5Credentials(username, password)) {
				return undefined;
			}

			return createSocks5SessionHandler(username, password);
		}

		if (pathname === env.VLESS_PATH) {
			const uuid = env.VLESS_UUID;

			if (!isValidVlessUuid(uuid)) {
				return undefined;
			}

			return createVlessSessionHandler(uuid);
		}

		return undefined;
	},
});

export default {
	fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return tunnelWorker.fetch(request, env as unknown as TunnelWorkerEnvironment);
	},
} satisfies ExportedHandler<Env>;
