import { describe, expect, it } from 'vitest';
import { runSession } from '../../src/core/session';
import type { TcpDialer, TcpSocket } from '../../src/dialers/tcp';
import { createVlessSessionHandler } from '../../src/protocols/vless-session';
import { attachWebSocketTransport, type WebSocketTransport } from '../../src/transports/websocket';

const TEST_UUID = '00112233-4455-4677-8899-aabbccddeeff';

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

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function makeVlessRequest(): Uint8Array {
	const uuidHex = TEST_UUID.replaceAll('-', '');
	const uuid = Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(uuidHex.slice(index * 2, index * 2 + 2), 16));
	const hostname = new TextEncoder().encode('example.com');

	return concatenate(new Uint8Array([0]), uuid, new Uint8Array([0, 1, 0, 80, 2, hostname.byteLength]), hostname);
}

function createTunnel(): { client: WebSocket; transport: WebSocketTransport } {
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	const transport = attachWebSocketTransport(server, { maxQueuedIncomingBytes: 1024 });

	client.binaryType = 'arraybuffer';
	client.accept();
	server.accept({ allowHalfOpen: true });

	return { client, transport };
}

function createSocket(opened: Promise<unknown> = new Promise<unknown>(() => undefined)): {
	socket: TcpSocket;
	closed: Promise<void>;
	readonly closeCount: number;
} {
	let resolveClosed!: () => void;
	let closeCount = 0;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const socket: TcpSocket = {
		readable: new ReadableStream<Uint8Array>(),
		writable: new WritableStream<Uint8Array>(),
		opened,
		closed,
		async close() {
			closeCount += 1;
			resolveClosed();
		},
	};

	return {
		socket,
		closed,
		get closeCount() {
			return closeCount;
		},
	};
}

function closeTunnel(client: WebSocket, transport: WebSocketTransport): void {
	if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
		client.close(1000, 'Test cleanup');
	}

	transport.close(1000, 'Test cleanup');
}

describe('VLESS TCP lifecycle', () => {
	it('closes TCP and settles when the peer disconnects while socket.opened is pending', async () => {
		const { client, transport } = createTunnel();
		let signalDialStarted!: () => void;
		const dialStarted = new Promise<void>((resolve) => {
			signalDialStarted = resolve;
		});
		const socketHarness = createSocket();
		const dial: TcpDialer = () => {
			signalDialStarted();
			return socketHarness.socket;
		};
		const sessionTask = runSession(transport, createVlessSessionHandler(TEST_UUID, dial));

		try {
			client.send(makeVlessRequest());
			await withTimeout(dialStarted);
			client.close(1000, 'Disconnected while TCP was opening');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: { code: 1000 },
			});
			await withTimeout(socketHarness.closed);
			expect(socketHarness.closeCount).toBe(1);
		} finally {
			closeTunnel(client, transport);
			await withTimeout(sessionTask).catch(() => undefined);
		}
	});

	it('closes a TCP socket that resolves after the WebSocket peer has disconnected', async () => {
		const { client, transport } = createTunnel();
		let signalDialStarted!: () => void;
		const dialStarted = new Promise<void>((resolve) => {
			signalDialStarted = resolve;
		});
		let resolveDial!: (socket: TcpSocket) => void;
		let dialResolved = false;
		const pendingDial = new Promise<TcpSocket>((resolve) => {
			resolveDial = resolve;
		});
		const lateSocket = createSocket();
		const dial: TcpDialer = () => {
			signalDialStarted();
			return pendingDial;
		};
		const sessionTask = runSession(transport, createVlessSessionHandler(TEST_UUID, dial));

		const resolvePendingDial = (): void => {
			if (dialResolved) {
				return;
			}

			dialResolved = true;
			resolveDial(lateSocket.socket);
		};

		try {
			client.send(makeVlessRequest());
			await withTimeout(dialStarted);
			client.close(1000, 'Disconnected during TCP dial');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: { code: 1000 },
			});

			resolvePendingDial();
			await withTimeout(lateSocket.closed);
			expect(lateSocket.closeCount).toBe(1);
		} finally {
			resolvePendingDial();
			closeTunnel(client, transport);
			await withTimeout(sessionTask).catch(() => undefined);
			await withTimeout(lateSocket.closed).catch(() => undefined);
		}
	});
});
