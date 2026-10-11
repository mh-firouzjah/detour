import { describe, expect, it } from 'vitest';
import { runSession } from '../../src/core/session';
import type { TcpDialer, TcpSocket } from '../../src/dialers/tcp';
import { createTrojanSessionHandler } from '../../src/protocols/trojan-session';
import { hashTrojanPassword } from '../../src/protocols/trojan';
import { attachWebSocketTransport } from '../../src/transports/websocket';

const PASSWORD = 'trojan-test-password';
const CRLF = new Uint8Array([0x0d, 0x0a]);

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
	const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function makeTrojanRequest(): Uint8Array {
	const domain = new TextEncoder().encode('example.com');
	return concatenate(
		new TextEncoder().encode(hashTrojanPassword(PASSWORD)),
		CRLF,
		new Uint8Array([0x01, 0x03, domain.byteLength]),
		domain,
		new Uint8Array([0x00, 0x50]),
		CRLF,
	);
}

function createPendingSocket(): { socket: TcpSocket; closed: Promise<void>; getCloseCount(): number } {
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let closeCount = 0;

	const socket: TcpSocket = {
		readable: new ReadableStream<Uint8Array>(),
		writable: new WritableStream<Uint8Array>(),
		opened: new Promise<unknown>(() => undefined),
		closed,
		async close() {
			closeCount += 1;
			resolveClosed();
		},
	};

	return { socket, closed, getCloseCount: () => closeCount };
}

describe('Trojan TCP lifecycle', () => {
	it('closes TCP and settles when the peer disconnects while socket.opened is pending', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, { maxQueuedIncomingBytes: 4096 });
		client.accept();
		server.accept({ allowHalfOpen: true });

		let signalDialStarted!: () => void;
		const dialStarted = new Promise<void>((resolve) => {
			signalDialStarted = resolve;
		});
		const pending = createPendingSocket();
		const dial: TcpDialer = () => {
			signalDialStarted();
			return pending.socket;
		};

		const sessionTask = runSession(transport, createTrojanSessionHandler(PASSWORD, dial));

		try {
			client.send(makeTrojanRequest());
			await withTimeout(dialStarted);
			client.close(1000, 'Disconnected while TCP was opening');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: { code: 1000 },
			});
			await expect(withTimeout(pending.closed)).resolves.toBeUndefined();
			expect(pending.getCloseCount()).toBe(1);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			transport.close(1000, 'Test cleanup');
			await withTimeout(sessionTask).catch(() => undefined);
		}
	});

	it('closes a TCP socket that resolves after the WebSocket peer has disconnected', async () => {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		client.binaryType = 'arraybuffer';

		const transport = attachWebSocketTransport(server, { maxQueuedIncomingBytes: 4096 });
		client.accept();
		server.accept({ allowHalfOpen: true });

		let signalDialStarted!: () => void;
		const dialStarted = new Promise<void>((resolve) => {
			signalDialStarted = resolve;
		});
		let resolveDial!: (socket: TcpSocket) => void;
		const delayedDial = new Promise<TcpSocket>((resolve) => {
			resolveDial = resolve;
		});
		const dial: TcpDialer = () => {
			signalDialStarted();
			return delayedDial;
		};
		const pending = createPendingSocket();
		const sessionTask = runSession(transport, createTrojanSessionHandler(PASSWORD, dial));

		try {
			client.send(makeTrojanRequest());
			await withTimeout(dialStarted);
			client.close(1000, 'Disconnected while TCP dial was pending');

			await expect(withTimeout(sessionTask)).resolves.toMatchObject({
				type: 'peer-closed',
				closeInfo: { code: 1000 },
			});

			resolveDial(pending.socket);
			await expect(withTimeout(pending.closed)).resolves.toBeUndefined();
			expect(pending.getCloseCount()).toBe(1);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			transport.close(1000, 'Test cleanup');
			await withTimeout(sessionTask).catch(() => undefined);
		}
	});
});
