import { describe, expect, it } from 'vitest';
import { runSession } from '../../src/core/session';
import { startTcpBridge } from '../../src/core/tcp-bridge';
import { dialTcp } from '../../src/dialers/tcp';
import { attachWebSocketTransport } from '../../src/transports/websocket';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
	let timer!: ReturnType<typeof setTimeout>;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs} ms`)), timeoutMs);
	});

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('TCP bridge integration', () => {
	it('relays a real HTTP exchange through WebSocket and TCP', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, {
			maxQueuedIncomingBytes: 64 * 1024,
		});

		server.accept();
		client.accept();

		const responseBytes: number[] = [];
		let messageError: Error | undefined;

		client.addEventListener('message', (event: MessageEvent) => {
			if (!(event.data instanceof ArrayBuffer)) {
				messageError = new Error('Expected binary WebSocket data');
				return;
			}

			responseBytes.push(...new Uint8Array(event.data));
		});

		let resolveClientClosed!: (event: CloseEvent) => void;
		const clientClosed = new Promise<CloseEvent>((resolve) => {
			resolveClientClosed = resolve;
		});

		client.addEventListener('close', resolveClientClosed, { once: true });

		const sessionTask = runSession(transport, async (session) => {
			const socket = dialTcp('example.com', 80);

			try {
				await withTimeout(socket.opened, 5000, 'TCP connection');
			} catch (error) {
				await socket.close().catch(() => undefined);
				throw error;
			}

			const bridge = startTcpBridge(session, socket);
			const result = await withTimeout(bridge.tcpToWebSocket, 10000, 'TCP response');

			if (result.type === 'source-error') {
				throw result.error;
			}

			if (result.type === 'destination-error') {
				throw result.error;
			}
		});

		try {
			const request = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');

			client.send(request);

			const [sessionResult, closeEvent] = await withTimeout(Promise.all([sessionTask, clientClosed]), 15000, 'WebSocket/TCP exchange');

			expect(sessionResult).toEqual({ type: 'completed' });
			expect(closeEvent.code).toBe(1000);
			expect(messageError).toBeUndefined();

			const response = new TextDecoder().decode(Uint8Array.from(responseBytes));
			expect(response).toMatch(/^HTTP\/1\.[01] \d{3} /);
		} finally {
			if (client.readyState === WebSocket.OPEN) {
				client.close(1000, 'Test cleanup');
			}

			transport.close(1000, 'Test cleanup');
		}
	});
});
