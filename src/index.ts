import { createSocks5SessionHandler, areValidSocks5Credentials } from './protocols/socks5-session';
import { createTunnelWorker, MAX_QUEUED_INCOMING_BYTES, type TunnelWorkerEnvironment } from './worker';

const tunnelWorker = createTunnelWorker({
	maxQueuedIncomingBytes: MAX_QUEUED_INCOMING_BYTES,
	sessionHandlerFactory(env) {
		const username = env.SOCKS5_USERNAME;
		const password = env.SOCKS5_PASSWORD;

		if (username === undefined || password === undefined || !areValidSocks5Credentials(username, password)) {
			return undefined;
		}

		return createSocks5SessionHandler(username, password);
	},
});

export default {
	fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return tunnelWorker.fetch(request, env as unknown as TunnelWorkerEnvironment);
	},
} satisfies ExportedHandler<Env>;
