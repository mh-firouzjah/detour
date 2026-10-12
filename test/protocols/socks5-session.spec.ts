import { describe, expect, it } from 'vitest';
import { runSession } from '../../src/core/session';
import type { TcpDialer, TcpSocket } from '../../src/dialers/tcp';
import { createSocks5SessionHandler } from '../../src/protocols/socks5-session';
import { attachWebSocketTransport } from '../../src/transports/websocket';

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

function nextMessage(socket: WebSocket): Promise<Uint8Array> {
	return new Promise<Uint8Array>((resolve, reject) => {
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.removeEventListener('message', onMessage);
			socket.removeEventListener('close', onClose);
		};

		const onMessage = (event: MessageEvent): void => {
			cleanup();

			if (!(event.data instanceof ArrayBuffer)) {
				reject(new Error('Expected binary WebSocket data'));
				return;
			}

			resolve(new Uint8Array(event.data));
		};

		const onClose = (): void => {
			cleanup();
			reject(new Error('WebSocket closed before the expected reply'));
		};

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for a WebSocket reply'));
		}, 1500);

		socket.addEventListener('message', onMessage);
		socket.addEventListener('close', onClose);
	});
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function startSocks5Connect(client: WebSocket): Promise<void> {
	const methodReply = nextMessage(client);
	client.send(new Uint8Array([0x05, 0x01, 0x02]));
	expect(Array.from(await withTimeout(methodReply))).toEqual([0x05, 0x02]);

	const authReply = nextMessage(client);
	client.send(new Uint8Array([0x01, 0x04, 0x75, 0x73, 0x65, 0x72, 0x04, 0x70, 0x61, 0x73, 0x73]));
	expect(Array.from(await withTimeout(authReply))).toEqual([0x01, 0x00]);

	client.send(new Uint8Array([0x05, 0x01, 0x00, 0x01, 192, 0, 2, 1, 0x01, 0xbb]));
}

describe('SOCKS5 TCP lifecycle', () => {
	it('closes TCP if the WebSocket peer disconnects while TCP is opening', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, {
			maxQueuedIncomingBytes: 1024,
		});

		client.accept();
		server.accept({ allowHalfOpen: true });

		let signalDialStarted!: () => void;
		const dialStarted = new Promise<void>((resolve) => {
			signalDialStarted = resolve;
		});

		let resolveSocketClosed!: () => void;
		const socketClosed = new Promise<void>((resolve) => {
			resolveSocketClosed = resolve;
		});

		let closeCount = 0;

		const socket: TcpSocket = {
			readable: new ReadableStream<Uint8Array>(),
			writable: new WritableStream<Uint8Array>(),
			opened: new Promise<unknown>(() => undefined),
			closed: socketClosed,
			async close() {
				closeCount += 1;
				resolveSocketClosed();
			},
		};

		const dial: TcpDialer = () => {
			signalDialStarted();
			return socket;
		};

		const sessionTask = runSession(transport, createSocks5SessionHandler('user', 'pass', dial));

		try {
			const methodReply = nextMessage(client);
			client.send(new Uint8Array([0x05, 0x01, 0x02]));
			expect(Array.from(await withTimeout(methodReply))).toEqual([0x05, 0x02]);

			const authReply = nextMessage(client);
			client.send(new Uint8Array([0x01, 0x04, 0x75, 0x73, 0x65, 0x72, 0x04, 0x70, 0x61, 0x73, 0x73]));
			expect(Array.from(await withTimeout(authReply))).toEqual([0x01, 0x00]);

			client.send(new Uint8Array([0x05, 0x01, 0x00, 0x01, 192, 0, 2, 1, 0x01, 0xbb]));

			await withTimeout(dialStarted);
			client.close(1000, 'Disconnected while TCP was opening');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: { code: 1000 },
			});
			expect(closeCount).toBe(1);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}

			transport.close(1000, 'Test cleanup');
			await withTimeout(sessionTask).catch(() => undefined);
		}
	});

	it('settles on peer disconnect during an async dial and closes the late socket once', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, { maxQueuedIncomingBytes: 1024 });
		client.accept();
		server.accept({ allowHalfOpen: true });

		const pendingDial = deferred<TcpSocket>();
		const dialStarted = deferred<void>();
		const dial: TcpDialer = () => {
			dialStarted.resolve();
			return pendingDial.promise;
		};
		let closeCount = 0;
		let resolveSocketClosed!: () => void;
		const socketClosed = new Promise<void>((resolve) => {
			resolveSocketClosed = resolve;
		});
		const socket: TcpSocket = {
			readable: new ReadableStream<Uint8Array>(),
			writable: new WritableStream<Uint8Array>(),
			opened: Promise.resolve(),
			closed: socketClosed,
			async close() {
				closeCount += 1;
				resolveSocketClosed();
			},
		};

		const sessionTask = runSession(transport, createSocks5SessionHandler('user', 'pass', dial));
		let dialResolved = false;

		try {
			await startSocks5Connect(client);
			await withTimeout(dialStarted.promise);
			client.close(1000, 'Disconnected while TCP was opening');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({ type: 'peer-closed' });

			pendingDial.resolve(socket);
			dialResolved = true;
			await withTimeout(sessionTask);
			await withTimeout(socketClosed);
			expect(closeCount).toBe(1);
		} finally {
			if (!dialResolved) {
				pendingDial.resolve(socket);
			}
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			transport.close(1000, 'Test cleanup');
			await withTimeout(sessionTask).catch(() => undefined);
			await withTimeout(socketClosed).catch(() => undefined);
		}
	});

	it('handles a pending dial rejection after peer disconnect without an unhandled rejection', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, { maxQueuedIncomingBytes: 1024 });
		client.accept();
		server.accept({ allowHalfOpen: true });

		const pendingDial = deferred<TcpSocket>();
		const dialStarted = deferred<void>();
		const dial: TcpDialer = () => {
			dialStarted.resolve();
			return pendingDial.promise;
		};
		const sessionTask = runSession(transport, createSocks5SessionHandler('user', 'pass', dial));
		let dialRejected = false;

		try {
			await startSocks5Connect(client);
			await withTimeout(dialStarted.promise);
			client.close(1000, 'Disconnected while TCP was opening');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({ type: 'peer-closed' });

			pendingDial.reject(new Error('Late dial failure'));
			dialRejected = true;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await expect(sessionTask).resolves.toMatchObject({ type: 'peer-closed' });
		} finally {
			if (!dialRejected) {
				pendingDial.reject(new Error('Test cleanup'));
			}
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			transport.close(1000, 'Test cleanup');
			await withTimeout(sessionTask).catch(() => undefined);
		}
	});
});
