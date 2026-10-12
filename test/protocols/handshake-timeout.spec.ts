import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSession, type SessionContext } from '../../src/core/session';
import type { TcpDialer, TcpSocket } from '../../src/dialers/tcp';
import { createSocks5SessionHandler } from '../../src/protocols/socks5-session';
import { createTrojanSessionHandler } from '../../src/protocols/trojan-session';
import { createVlessSessionHandler } from '../../src/protocols/vless-session';
import { hashTrojanPassword } from '../../src/protocols/trojan';
import type { WebSocketCloseInfo, WebSocketTransport } from '../../src/transports/websocket';

const HANDSHAKE_TIMEOUT_MS = 5000;
const VLESS_UUID = '00112233-4455-4677-8899-aabbccddeeff';
const TROJAN_PASSWORD = 'timeout-test-password';

type TransportHarness = {
	transport: WebSocketTransport;
	session: SessionContext;
	push(data: Uint8Array): void;
	peerClose(): void;
	closeCount(): number;
	lastClose(): { code: number; reason: string } | undefined;
};

function createTransportHarness(onWrite: (data: Uint8Array) => void = () => undefined): TransportHarness {
	let readableController!: ReadableStreamDefaultController<Uint8Array>;
	let resolveClosed!: (info: WebSocketCloseInfo) => void;
	let closes = 0;
	let peerClosed = false;
	let lastClose: { code: number; reason: string } | undefined;
	const closed = new Promise<WebSocketCloseInfo>((resolve) => {
		resolveClosed = resolve;
	});

	const readable = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				readableController = controller;
			},
		},
		{ highWaterMark: 0 },
	);
	const writable = new WritableStream<Uint8Array>({
		write(data) {
			onWrite(data);
		},
	});
	const transport: WebSocketTransport = {
		readable,
		writable,
		closed,
		close(code = 1000, reason = '') {
			if (closes > 0 || peerClosed) {
				return;
			}
			closes += 1;
			lastClose = { code, reason };
			readableController.close();
			resolveClosed({ code, reason, wasClean: true });
		},
	};

	const session: SessionContext = {
		...transport,
		signal: new AbortController().signal,
	};

	return {
		transport,
		session,
		push(data) {
			readableController.enqueue(data);
		},
		peerClose() {
			peerClosed = true;
			readableController.close();
			resolveClosed({ code: 1000, reason: 'Peer disconnected', wasClean: true });
		},
		closeCount: () => closes,
		lastClose: () => lastClose,
	};
}

function createSocket(onWrite: (data: Uint8Array) => void = () => undefined): TcpSocket & { push(data: Uint8Array): void } {
	let readableController!: ReadableStreamDefaultController<Uint8Array>;
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			readableController = controller;
		},
	});

	return {
		readable,
		writable: new WritableStream<Uint8Array>({
			write(data) {
				onWrite(data);
			},
		}),
		opened: Promise.resolve(),
		closed,
		push(data) {
			readableController.enqueue(data);
		},
		async close() {
			readableController.close();
			resolveClosed();
		},
	};
}

function makeVlessRequest(): Uint8Array {
	const uuidHex = VLESS_UUID.replaceAll('-', '');
	const uuid = Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(uuidHex.slice(index * 2, index * 2 + 2), 16));
	const hostname = new TextEncoder().encode('example.com');
	return new Uint8Array([0, ...uuid, 0, 1, 0, 80, 2, hostname.byteLength, ...hostname]);
}

function makeTrojanRequest(): Uint8Array {
	const hostname = new TextEncoder().encode('example.com');
	return new Uint8Array([
		...new TextEncoder().encode(hashTrojanPassword(TROJAN_PASSWORD)),
		0x0d,
		0x0a,
		0x01,
		0x03,
		hostname.byteLength,
		...hostname,
		0,
		80,
		0x0d,
		0x0a,
	]);
}

const protocols = [
	{
		name: 'SOCKS5',
		createHandler: (dial: TcpDialer) => createSocks5SessionHandler('user', 'pass', dial),
		partialHeader: new Uint8Array([0x05]),
		completeHandshake: new Uint8Array([
			0x05, 0x01, 0x02, 0x01, 0x04, 0x75, 0x73, 0x65, 0x72, 0x04, 0x70, 0x61, 0x73, 0x73, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80,
		]),
	},
	{
		name: 'VLESS',
		createHandler: (dial: TcpDialer) => createVlessSessionHandler(VLESS_UUID, dial),
		partialHeader: new Uint8Array([0x00]),
		completeHandshake: makeVlessRequest(),
	},
	{
		name: 'Trojan',
		createHandler: (dial: TcpDialer) => createTrojanSessionHandler(TROJAN_PASSWORD, dial),
		partialHeader: new TextEncoder().encode(hashTrojanPassword(TROJAN_PASSWORD).slice(0, 1)),
		completeHandshake: makeTrojanRequest(),
	},
];

afterEach(() => {
	vi.useRealTimers();
});

describe.each(protocols)('$name handshake deadline', ({ createHandler, partialHeader, completeHandshake }) => {
	it('closes a silent session when no handshake data arrives by the absolute deadline', async () => {
		vi.useFakeTimers();
		const harness = createTransportHarness();
		const dial = vi.fn<TcpDialer>(() => createSocket());
		const sessionTask = runSession(harness.transport, createHandler(dial));

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

		expect(harness.closeCount()).toBe(1);
		expect(harness.lastClose()).toEqual({ code: 1008, reason: 'Handshake timeout' });
		expect(dial).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await expect(sessionTask).resolves.toMatchObject({ type: 'peer-closed' });
	});

	it('closes an incomplete header at the deadline', async () => {
		vi.useFakeTimers();
		const harness = createTransportHarness();
		const dial = vi.fn<TcpDialer>(() => createSocket());
		const sessionTask = runSession(harness.transport, createHandler(dial));

		await Promise.resolve();
		harness.push(partialHeader);
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

		expect(harness.closeCount()).toBe(1);
		expect(harness.lastClose()).toEqual({ code: 1008, reason: 'Handshake timeout' });
		expect(dial).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await expect(sessionTask).resolves.toMatchObject({ type: 'peer-closed' });
	});

	it('does not extend the deadline when bytes arrive slowly', async () => {
		vi.useFakeTimers();
		const harness = createTransportHarness();
		const dial = vi.fn<TcpDialer>(() => createSocket());
		const sessionTask = runSession(harness.transport, createHandler(dial));

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1000);
		harness.push(partialHeader);
		await vi.advanceTimersByTimeAsync(1000);

		expect(harness.closeCount()).toBe(1);
		expect(harness.lastClose()).toEqual({ code: 1008, reason: 'Handshake timeout' });
		expect(dial).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await expect(sessionTask).resolves.toMatchObject({ type: 'peer-closed' });
	});

	it('clears the timer before dialing and leaves an established tunnel open beyond the deadline', async () => {
		vi.useFakeTimers();
		const tcpReceived: Uint8Array[] = [];
		const webSocketReceived: Uint8Array[] = [];
		const harness = createTransportHarness((data) => webSocketReceived.push(data));
		const socket = createSocket((data) => tcpReceived.push(data));
		const dial = vi.fn<TcpDialer>(() => {
			expect(vi.getTimerCount()).toBe(0);
			return socket;
		});
		const sessionTask = runSession(harness.transport, createHandler(dial));

		await Promise.resolve();
		harness.push(completeHandshake);
		await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1);

		expect(harness.closeCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(socket.readable.locked).toBe(true);

		const clientPayload = new Uint8Array([0x10, 0x20, 0x30]);
		harness.push(clientPayload);
		await vi.waitFor(() => expect(tcpReceived.some((chunk) => chunk === clientPayload)).toBe(true));

		const targetPayload = new Uint8Array([0xa0, 0xb0, 0xc0]);
		socket.push(targetPayload);
		await vi.waitFor(() => expect(webSocketReceived.some((chunk) => chunk === targetPayload)).toBe(true));

		expect(harness.closeCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		harness.transport.close(1000, 'Test cleanup');
		await expect(sessionTask).resolves.toMatchObject({ type: 'peer-closed' });
	});

	it('clears its timer and settles when the peer disconnects during an incomplete handshake', async () => {
		vi.useFakeTimers();
		const harness = createTransportHarness();
		const dial = vi.fn<TcpDialer>(() => createSocket());
		const sessionTask = runSession(harness.transport, createHandler(dial));

		await Promise.resolve();
		harness.push(partialHeader);
		harness.peerClose();

		await expect(sessionTask).resolves.toMatchObject({
			type: 'peer-closed',
			closeInfo: { code: 1000, reason: 'Peer disconnected' },
		});
		expect(harness.closeCount()).toBe(0);
		expect(dial).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
