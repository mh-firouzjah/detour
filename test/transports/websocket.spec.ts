import { describe, expect, it } from 'vitest';
import { attachWebSocketTransport, type WebSocketTransport } from '../../src/transports/websocket';

const DEFAULT_OPTIONS = {
	maxQueuedIncomingBytes: 1024,
};

function withTimeout<T>(promise: Promise<T>, timeoutMs = 1500): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Timed out after ${timeoutMs} ms`));
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function createTransport(options: { maxQueuedIncomingBytes: number } = DEFAULT_OPTIONS): {
	client: WebSocket;
	server: WebSocket;
	transport: WebSocketTransport;
} {
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	client.binaryType = 'arraybuffer';

	const transport = attachWebSocketTransport(server, options);

	client.accept();
	server.accept();

	return { client, server, transport };
}

function receiveMessage(socket: WebSocket, timeoutMs = 1500): Promise<number[]> {
	return new Promise<number[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.removeEventListener('message', onMessage);
			reject(new Error(`Timed out after ${timeoutMs} ms waiting for a WebSocket message`));
		}, timeoutMs);

		const onMessage = (event: MessageEvent) => {
			clearTimeout(timer);
			socket.removeEventListener('message', onMessage);

			if (!(event.data instanceof ArrayBuffer)) {
				reject(new Error('Expected binary WebSocket response'));
				return;
			}

			resolve(Array.from(new Uint8Array(event.data)));
		};

		socket.addEventListener('message', onMessage);
	});
}

function cleanup(client: WebSocket, transport: WebSocketTransport): void {
	transport.close(1000, 'Test cleanup');

	if (client.readyState === WebSocket.OPEN) {
		client.close(1000, 'Test cleanup');
	}
}

describe('WebSocket byte transport', () => {
	it('delivers real binary messages in order', async () => {
		const { client, transport } = createTransport();
		const reader = transport.readable.getReader();

		try {
			const firstRead = withTimeout(reader.read());
			client.send(new Uint8Array([0, 1, 255]));

			const first = await firstRead;
			expect(first.done).toBe(false);
			expect(Array.from(first.value ?? [])).toEqual([0, 1, 255]);

			const secondRead = withTimeout(reader.read());
			client.send(new Uint8Array([4, 5]));

			const second = await secondRead;
			expect(second.done).toBe(false);
			expect(Array.from(second.value ?? [])).toEqual([4, 5]);
		} finally {
			reader.releaseLock();
			cleanup(client, transport);
		}
	});

	it('sends binary data to the real peer and preserves write order', async () => {
		const { client, transport } = createTransport();
		const writer = transport.writable.getWriter();

		try {
			const firstMessage = receiveMessage(client);
			const [firstWrite, firstReceived] = await Promise.all([withTimeout(writer.write(new Uint8Array([1, 2, 3]))), firstMessage]);

			expect(firstWrite).toBeUndefined();
			expect(firstReceived).toEqual([1, 2, 3]);

			const secondMessage = receiveMessage(client);
			const [secondWrite, secondReceived] = await Promise.all([withTimeout(writer.write(new Uint8Array([4, 5, 6]))), secondMessage]);

			expect(secondWrite).toBeUndefined();
			expect(secondReceived).toEqual([4, 5, 6]);
		} finally {
			writer.releaseLock();
			cleanup(client, transport);
		}
	});

	it('ends the readable stream when the peer closes the WebSocket', async () => {
		const { client, transport } = createTransport();
		const reader = transport.readable.getReader();

		try {
			const pendingRead = withTimeout(reader.read());
			const closeInfoPromise = withTimeout(transport.closed);

			client.close(1000, 'peer finished');

			await expect(pendingRead).resolves.toMatchObject({
				done: true,
			});

			await expect(closeInfoPromise).resolves.toMatchObject({
				code: 1000,
				reason: 'peer finished',
				wasClean: true,
			});
		} finally {
			reader.releaseLock();
			cleanup(client, transport);
		}
	});

	it('rejects text messages because the transport carries bytes only', async () => {
		const { client, transport } = createTransport();
		const reader = transport.readable.getReader();

		try {
			const pendingRead = withTimeout(reader.read());
			client.send('not binary');

			await expect(pendingRead).rejects.toThrow('Expected a binary WebSocket message');
		} finally {
			reader.releaseLock();
			cleanup(client, transport);
		}
	});

	it('bounds queued incoming bytes and reports overflow', async () => {
		const { client, transport } = createTransport({
			maxQueuedIncomingBytes: 4,
		});

		try {
			client.send(new Uint8Array([1, 2, 3, 4, 5]));
			await new Promise<void>((resolve) => setTimeout(resolve, 30));

			const reader = transport.readable.getReader();

			try {
				await expect(withTimeout(reader.read())).rejects.toThrow('Incoming WebSocket queue limit exceeded');
			} finally {
				reader.releaseLock();
			}
		} finally {
			cleanup(client, transport);
		}
	});
});
