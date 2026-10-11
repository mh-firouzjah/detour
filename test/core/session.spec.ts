import { describe, expect, it } from 'vitest';
import { runSession } from '../../src/core/session';
import { attachWebSocketTransport, type WebSocketTransport } from '../../src/transports/websocket';

const TEST_OPTIONS = {
	maxQueuedIncomingBytes: 1024,
};

function createSession(): {
	client: WebSocket;
	transport: WebSocketTransport;
} {
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	const transport = attachWebSocketTransport(server, TEST_OPTIONS);

	client.accept();
	server.accept();

	return { client, transport };
}

function waitForClose(socket: WebSocket, timeoutMs = 1500): Promise<CloseEvent> {
	return new Promise<CloseEvent>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.removeEventListener('close', onClose);
			reject(new Error(`Timed out after ${timeoutMs} ms waiting for close`));
		}, timeoutMs);

		function onClose(event: CloseEvent): void {
			clearTimeout(timer);
			socket.removeEventListener('close', onClose);
			resolve(event);
		}

		socket.addEventListener('close', onClose);
	});
}

function cleanup(client: WebSocket, transport: WebSocketTransport): void {
	transport.close(1000, 'Test cleanup');

	if (client.readyState === WebSocket.OPEN) {
		client.close(1000, 'Test cleanup');
	}
}

describe('runSession', () => {
	it('closes the transport when the handler completes', async () => {
		const { client, transport } = createSession();
		const closePromise = waitForClose(client);

		try {
			await expect(runSession(transport, async () => {})).resolves.toEqual({
				type: 'completed',
			});

			await expect(closePromise).resolves.toMatchObject({
				code: 1000,
				reason: 'Session completed',
			});
		} finally {
			cleanup(client, transport);
		}
	});

	it('aborts the handler and waits for its cleanup after peer close', async () => {
		const { client, transport } = createSession();
		let sessionSignal: AbortSignal | undefined;

		try {
			const sessionPromise = runSession(transport, async (session) => {
				sessionSignal = session.signal;

				const reader = session.readable.getReader();
				try {
					await reader.read();
				} finally {
					reader.releaseLock();
				}
			});

			client.close(1000, 'Peer finished');

			await expect(sessionPromise).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: {
					code: 1000,
					reason: 'Peer finished',
				},
			});

			expect(sessionSignal?.aborted).toBe(true);
		} finally {
			cleanup(client, transport);
		}
	});

	it('reports handler errors and closes with an internal-error status', async () => {
		const { client, transport } = createSession();
		const failure = new Error('Handler failed');
		const closePromise = waitForClose(client);

		try {
			await expect(
				runSession(transport, () => {
					throw failure;
				}),
			).resolves.toEqual({
				type: 'handler-error',
				error: failure,
			});

			await expect(closePromise).resolves.toMatchObject({
				code: 1011,
				reason: 'Session handler failed',
			});
		} finally {
			cleanup(client, transport);
		}
	});
});
