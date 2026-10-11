import { describe, expect, it } from 'vitest';
import { createTunnelWorker } from '../src/worker';

const TEST_PATH = '/_detour_worker_test';
const TEST_QUEUE_LIMIT = 64 * 1024;

function makeRequest(path: string, init: RequestInit = {}): Request {
	return new Request(`https://example.com${path}`, init);
}

function receiveBytes(socket: WebSocket, timeoutMs = 1500): Promise<number[]> {
	return new Promise<number[]>((resolve, reject) => {
		const onMessage = (event: MessageEvent) => {
			clearTimeout(timer);
			socket.removeEventListener('message', onMessage);

			if (!(event.data instanceof ArrayBuffer)) {
				reject(new Error('Expected a binary WebSocket message'));
				return;
			}

			resolve(Array.from(new Uint8Array(event.data)));
		};

		const timer = setTimeout(() => {
			socket.removeEventListener('message', onMessage);
			reject(new Error(`Timed out after ${timeoutMs} ms waiting for a message`));
		}, timeoutMs);

		socket.addEventListener('message', onMessage);
	});
}

function waitForClose(socket: WebSocket, timeoutMs = 1500): Promise<CloseEvent> {
	return new Promise<CloseEvent>((resolve, reject) => {
		const onClose = (event: CloseEvent) => {
			clearTimeout(timer);
			socket.removeEventListener('close', onClose);
			resolve(event);
		};

		const timer = setTimeout(() => {
			socket.removeEventListener('close', onClose);
			reject(new Error(`Timed out after ${timeoutMs} ms waiting for close`));
		}, timeoutMs);

		socket.addEventListener('close', onClose);
	});
}

describe('Tunnel Worker', () => {
	it('returns 503 when the tunnel path is not configured', async () => {
		const worker = createTunnelWorker();
		const response = await worker.fetch(makeRequest('/anything'), {});

		expect(response.status).toBe(503);
	});

	it('returns 404 for a path mismatch', async () => {
		const worker = createTunnelWorker();
		const response = await worker.fetch(makeRequest('/wrong'), { TUNNEL_PATH: TEST_PATH });

		expect(response.status).toBe(404);
	});

	it('returns 405 and Allow: GET for other methods on the tunnel path', async () => {
		const worker = createTunnelWorker();
		const response = await worker.fetch(
			makeRequest(TEST_PATH, {
				method: 'POST',
				headers: { Upgrade: 'websocket' },
			}),
			{ TUNNEL_PATH: TEST_PATH },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET');
	});

	it('returns 426 when the request is not a WebSocket upgrade', async () => {
		const worker = createTunnelWorker();
		const response = await worker.fetch(makeRequest(TEST_PATH), { TUNNEL_PATH: TEST_PATH });

		expect(response.status).toBe(426);
		expect(response.headers.get('Upgrade')).toBe('websocket');
	});

	it('refuses an upgrade when no session handler is configured', async () => {
		const worker = createTunnelWorker();
		const response = await worker.fetch(makeRequest(TEST_PATH, { headers: { Upgrade: 'websocket' } }), { TUNNEL_PATH: TEST_PATH });

		expect(response.status).toBe(503);
	});

	it('connects a real WebSocket to a protocol-neutral session handler', async () => {
		const worker = createTunnelWorker({
			maxQueuedIncomingBytes: TEST_QUEUE_LIMIT,
			sessionHandler: async (session) => {
				const reader = session.readable.getReader();
				const writer = session.writable.getWriter();

				try {
					while (true) {
						const result = await reader.read();
						if (result.done) {
							return;
						}
						await writer.write(result.value);
					}
				} finally {
					reader.releaseLock();
					writer.releaseLock();
				}
			},
		});

		const response = await worker.fetch(makeRequest(TEST_PATH, { headers: { Upgrade: 'websocket' } }), { TUNNEL_PATH: TEST_PATH });

		expect(response.status).toBe(101);

		const client = (response as Response & { webSocket?: WebSocket }).webSocket;
		if (!client) {
			throw new Error('Expected the Worker response to contain a WebSocket');
		}

		try {
			client.binaryType = 'arraybuffer';
			client.accept();

			const echoedMessage = receiveBytes(client);
			client.send(new Uint8Array([0, 1, 255]));

			await expect(echoedMessage).resolves.toEqual([0, 1, 255]);

			const closed = waitForClose(client);
			client.close(1000, 'Test complete');
			await expect(closed).resolves.toMatchObject({ code: 1000 });
		} finally {
			if (client.readyState === WebSocket.OPEN) {
				client.close(1000, 'Test cleanup');
			}
		}
	});
});
