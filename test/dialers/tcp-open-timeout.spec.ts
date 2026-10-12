import { describe, expect, it } from 'vitest';
import type { TcpSocket } from '../../src/dialers/tcp';
import { DEFAULT_TCP_CONNECT_TIMEOUT_MS, resolveTcpConnectTimeoutMs, withTcpOpenTimeout } from '../../src/dialers/tcp';

function createSocket(opened: Promise<unknown>): { socket: TcpSocket; getCloseCount(): number } {
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

	return { socket, getCloseCount: () => closeCount };
}

describe('TCP socket open timeout', () => {
	it('defaults to three seconds', () => {
		expect(DEFAULT_TCP_CONNECT_TIMEOUT_MS).toBe(3000);
		expect(resolveTcpConnectTimeoutMs(undefined)).toBe(3000);
	});

	it('accepts valid configured timeout values', () => {
		expect(resolveTcpConnectTimeoutMs('500')).toBe(500);
		expect(resolveTcpConnectTimeoutMs('2500')).toBe(2500);
		expect(resolveTcpConnectTimeoutMs('10000')).toBe(10000);
		expect(resolveTcpConnectTimeoutMs(' 2500 ')).toBe(2500);
	});

	it('falls back to default for blank, malformed, or out-of-range values', () => {
		for (const value of ['', '   ', '0', '499', '10001', '3s', '-1', '1.5', '999999999999999999999999']) {
			expect(resolveTcpConnectTimeoutMs(value)).toBe(3000);
		}
	});

	it('closes a socket whose opened promise exceeds the timeout', async () => {
		const pendingSocket = createSocket(new Promise<unknown>(() => undefined));
		const socket = withTcpOpenTimeout(pendingSocket.socket, 10);

		await expect(socket.opened).rejects.toThrow('TCP socket did not open within 10 ms');
		await socket.close();
		expect(pendingSocket.getCloseCount()).toBe(1);
	});

	it('settles the opened promise promptly when a pending socket is closed', async () => {
		const pendingSocket = createSocket(new Promise<unknown>(() => undefined));
		const socket = withTcpOpenTimeout(pendingSocket.socket, 1000);

		await socket.close();
		await expect(socket.opened).rejects.toThrow('TCP socket closed before opening');
		expect(pendingSocket.getCloseCount()).toBe(1);
	});

	it('preserves successful socket opening and makes close idempotent', async () => {
		const pendingSocket = createSocket(Promise.resolve({ remoteAddress: '127.0.0.1' }));
		const socket = withTcpOpenTimeout(pendingSocket.socket, 1000);

		await expect(socket.opened).resolves.toEqual({ remoteAddress: '127.0.0.1' });
		await Promise.all([socket.close(), socket.close()]);
		expect(pendingSocket.getCloseCount()).toBe(1);
	});

	it('preserves the original opening error', async () => {
		const error = new Error('connection refused');
		const pendingSocket = createSocket(Promise.reject(error));
		const socket = withTcpOpenTimeout(pendingSocket.socket, 1000);

		await expect(socket.opened).rejects.toBe(error);
		await socket.close();
		expect(pendingSocket.getCloseCount()).toBe(1);
	});
});
