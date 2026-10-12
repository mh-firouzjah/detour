import { runSession, type SessionHandler } from './core/session';
import { attachWebSocketTransport } from './transports/websocket';

export interface TunnelWorkerEnvironment {
	TUNNEL_PATH?: string;
	SOCKS5_USERNAME?: string;
	SOCKS5_PASSWORD?: string;
	VLESS_PATH?: string;
	VLESS_UUID?: string;
	TROJAN_PATH?: string;
	TROJAN_PASSWORD?: string;
	TCP_CONNECT_TIMEOUT_MS?: string;
}

export type SessionHandlerFactory = (env: TunnelWorkerEnvironment, pathname: string) => SessionHandler | undefined;

export const MAX_QUEUED_INCOMING_BYTES = 32 * 1024 * 1024;

export interface TunnelWorkerOptions {
	sessionHandler?: SessionHandler;
	sessionHandlerFactory?: SessionHandlerFactory;
	maxQueuedIncomingBytes?: number;
}

function isValidTunnelPath(path: string | undefined): path is string {
	return (
		typeof path === 'string' && path.startsWith('/') && path !== '/' && !path.startsWith('//') && !path.includes('?') && !path.includes('#')
	);
}

const ROOT_PAGE_HTML = [
	'<!doctype html>',
	'<html lang="en">',
	'<head>',
	'<meta charset="utf-8">',
	'<meta name="viewport" content="width=device-width, initial-scale=1">',
	'<title>Network diagnostics</title>',
	'<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.25rem;color:#20242a}a{color:#0759c7}p{color:#59616b}</style>',
	'</head>',
	'<body>',
	'<h1>Network diagnostics</h1>',
	'<p>This endpoint is online.</p>',
	'<p><a href="https://speed.cloudflare.com/" rel="noopener noreferrer">Open connection test</a></p>',
	'</body>',
	'</html>',
].join('\n');

export function createTunnelWorker(options: TunnelWorkerOptions = {}) {
	const { sessionHandler: configuredSessionHandler, sessionHandlerFactory, maxQueuedIncomingBytes } = options;

	const hasHandlerConfiguration = configuredSessionHandler !== undefined || sessionHandlerFactory !== undefined;

	if (hasHandlerConfiguration && (!Number.isSafeInteger(maxQueuedIncomingBytes) || (maxQueuedIncomingBytes ?? 0) <= 0)) {
		throw new RangeError('A positive maxQueuedIncomingBytes is required when a session handler is configured');
	}

	return {
		async fetch(request: Request, env: TunnelWorkerEnvironment): Promise<Response> {
			const pathname = new URL(request.url).pathname;

			if (pathname === '/') {
				if (request.method !== 'GET' && request.method !== 'HEAD') {
					return new Response('Method not allowed', {
						status: 405,
						headers: { Allow: 'GET, HEAD' },
					});
				}

				return new Response(request.method === 'HEAD' ? null : ROOT_PAGE_HTML, {
					status: 200,
					headers: {
						'Content-Type': 'text/html; charset=UTF-8',
						'Cache-Control': 'no-store',
						'Content-Security-Policy':
							"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
						'X-Content-Type-Options': 'nosniff',
						'Referrer-Policy': 'no-referrer',
					},
				});
			}

			const candidatePaths = [env.TUNNEL_PATH, env.VLESS_PATH, env.TROJAN_PATH];
			const configuredPaths = candidatePaths.filter((path): path is string => path !== undefined);

			if (
				configuredPaths.length === 0 ||
				candidatePaths.some((path) => path !== undefined && !isValidTunnelPath(path)) ||
				new Set(configuredPaths).size !== configuredPaths.length
			) {
				return new Response('Service unavailable', { status: 503 });
			}

			if (!configuredPaths.includes(pathname)) {
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

			const sessionHandler = sessionHandlerFactory ? sessionHandlerFactory(env, pathname) : configuredSessionHandler;

			if (sessionHandler === undefined || maxQueuedIncomingBytes === undefined) {
				return new Response('Session handler unavailable', { status: 503 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];

			const transport = attachWebSocketTransport(server, {
				maxQueuedIncomingBytes,
			});

			server.accept({ allowHalfOpen: true });

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
