import { runSession, type SessionHandler } from './core/session';
import { attachWebSocketTransport } from './transports/websocket';

export interface TunnelWorkerEnvironment {
	TUNNEL_PATH?: string;
}

export interface TunnelWorkerOptions {
	sessionHandler?: SessionHandler;
	maxQueuedIncomingBytes?: number;
}

function isValidTunnelPath(path: string | undefined): path is string {
	return (
		typeof path === 'string' && path.startsWith('/') && path !== '/' && !path.startsWith('//') && !path.includes('?') && !path.includes('#')
	);
}

export function createTunnelWorker(options: TunnelWorkerOptions = {}) {
	const { sessionHandler, maxQueuedIncomingBytes } = options;

	if (sessionHandler !== undefined && (!Number.isSafeInteger(maxQueuedIncomingBytes) || (maxQueuedIncomingBytes ?? 0) <= 0)) {
		throw new RangeError('A positive maxQueuedIncomingBytes is required when a session handler is configured');
	}

	return {
		async fetch(request: Request, env: TunnelWorkerEnvironment): Promise<Response> {
			const tunnelPath = env.TUNNEL_PATH;

			if (!isValidTunnelPath(tunnelPath)) {
				return new Response('Service unavailable', { status: 503 });
			}

			if (new URL(request.url).pathname !== tunnelPath) {
				return new Response('Not found', { status: 404 });
			}

			if (request.method !== 'GET') {
				return new Response('Method not allowed', {
					status: 405,
					headers: { Allow: 'GET' },
				});
			}

			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket upgrade', {
					status: 426,
					headers: { Upgrade: 'websocket' },
				});
			}

			// Do not accept unauthenticated, protocol-less tunnel sessions.
			// A protocol handler will be supplied when protocol integration begins.
			if (sessionHandler === undefined) {
				return new Response('Session handler unavailable', { status: 503 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];

			const transport = attachWebSocketTransport(server, {
				maxQueuedIncomingBytes: maxQueuedIncomingBytes as number,
			});

			// Attach transport listeners and configure binaryType before accept().
			server.accept();

			void runSession(transport, sessionHandler).then(
				(result) => {
					if (result.type === 'handler-error') {
						console.error('Tunnel session handler failed', result.error);
					}
				},
				(error: unknown) => {
					console.error('Tunnel session lifecycle failed', error);
					transport.close(1011, 'Session lifecycle failed');
				},
			);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		},
	};
}
