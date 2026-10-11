import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type MessageInbox = {
	next(timeoutMs?: number): Promise<Uint8Array | null>;
	readonly closeEvent: CloseEvent | undefined;
};

function createMessageInbox(socket: WebSocket): MessageInbox {
	const queued: Uint8Array[] = [];
	const waiters: {
		resolve(value: Uint8Array | null): void;
		reject(error: Error): void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

	let closed = false;
	let failure: Error | undefined;
	let closeEvent: CloseEvent | undefined;

	function settleWaitersOnClose(): void {
		while (waiters.length > 0) {
			const waiter = waiters.shift()!;
			clearTimeout(waiter.timer);
			waiter.resolve(null);
		}
	}

	function fail(error: Error): void {
		failure = error;

		while (waiters.length > 0) {
			const waiter = waiters.shift()!;
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	socket.addEventListener('message', (event: MessageEvent) => {
		if (!(event.data instanceof ArrayBuffer)) {
			fail(new Error('Expected binary WebSocket message'));
			return;
		}

		const data = new Uint8Array(event.data);
		const waiter = waiters.shift();

		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(data);
		} else {
			queued.push(data);
		}
	});

	socket.addEventListener('error', () => {
		fail(new Error('WebSocket client error'));
	});

	socket.addEventListener('close', (event: CloseEvent) => {
		closeEvent = event;
		closed = true;
		settleWaitersOnClose();
	});

	return {
		next(timeoutMs = 5000): Promise<Uint8Array | null> {
			if (queued.length > 0) {
				return Promise.resolve(queued.shift()!);
			}

			if (failure) {
				return Promise.reject(failure);
			}

			if (closed) {
				return Promise.resolve(null);
			}

			return new Promise<Uint8Array | null>((resolve, reject) => {
				const waiter = {
					resolve,
					reject,
					timer: setTimeout(() => {
						const index = waiters.indexOf(waiter);
						if (index !== -1) {
							waiters.splice(index, 1);
						}
						reject(new Error(`Timed out after ${timeoutMs} ms waiting for WebSocket data`));
					}, timeoutMs),
				};

				waiters.push(waiter);
			});
		},
		get closeEvent(): CloseEvent | undefined {
			return closeEvent;
		},
	};
}

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return combined;
}

async function expectMessage(inbox: MessageInbox, expected: number[], timeoutMs = 5000): Promise<void> {
	const message = await inbox.next(timeoutMs);
	expect(message === null ? null : Array.from(message)).toEqual(expected);
}

async function openTunnel(): Promise<{
	client: WebSocket;
	inbox: MessageInbox;
	context: ReturnType<typeof createExecutionContext>;
}> {
	if (!env.TUNNEL_PATH || !env.SOCKS5_USERNAME || !env.SOCKS5_PASSWORD) {
		throw new Error('TUNNEL_PATH and SOCKS5 credentials must be configured in .dev.vars');
	}

	const context = createExecutionContext();
	const response = await worker.fetch(
		new IncomingRequest(`https://example.com${env.TUNNEL_PATH}`, {
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
			},
		}),
		env,
		context,
	);

	expect(response.status).toBe(101);

	const client = response.webSocket;
	if (!client) {
		throw new Error('Expected the Worker response to contain a WebSocket');
	}

	client.binaryType = 'arraybuffer';
	client.accept();

	return {
		client,
		inbox: createMessageInbox(client),
		context,
	};
}

async function negotiateUsernamePassword(
	client: WebSocket,
	inbox: MessageInbox,
	username: Uint8Array,
	password: Uint8Array,
): Promise<void> {
	// Fragment the greeting and authentication across WebSocket messages.
	client.send(new Uint8Array([0x05]));
	client.send(new Uint8Array([0x01, 0x02]));
	await expectMessage(inbox, [0x05, 0x02]);

	client.send(new Uint8Array([0x01, username.byteLength]));
	client.send(username);
	client.send(new Uint8Array([password.byteLength]));
	client.send(password);
}

describe('Production SOCKS5 Worker', () => {
	it('authenticates, CONNECTs to a real Internet host, and relays its HTTP response', async () => {
		const { client, inbox, context } = await openTunnel();
		const encoder = new TextEncoder();

		try {
			const username = encoder.encode(env.SOCKS5_USERNAME);
			const password = encoder.encode(env.SOCKS5_PASSWORD);

			await negotiateUsernamePassword(client, inbox, username, password);
			await expectMessage(inbox, [0x01, 0x00]);

			const hostname = encoder.encode('example.com');
			client.send(new Uint8Array([0x05, 0x01, 0x00, 0x03, hostname.byteLength]));
			client.send(concatenate(hostname, new Uint8Array([0x00, 0x50])));

			const connectReply = await inbox.next(10000);
			expect(connectReply).not.toBeNull();
			expect(Array.from(connectReply ?? []).slice(0, 2)).toEqual([0x05, 0x00]);

			client.send(encoder.encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'));

			const responseBytes: number[] = [];

			while (true) {
				const message = await inbox.next(15000);
				if (message === null) {
					break;
				}

				responseBytes.push(...message);
			}

			const response = new TextDecoder().decode(new Uint8Array(responseBytes));
			expect(response).toMatch(/^HTTP\/1\.[01] 200\b/);
			expect(inbox.closeEvent?.code).toBe(1000);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}

			await waitOnExecutionContext(context);
		}
	});

	it('rejects incorrect credentials before opening a destination TCP socket', async () => {
		const { client, inbox, context } = await openTunnel();
		const encoder = new TextEncoder();

		try {
			const username = encoder.encode(env.SOCKS5_USERNAME);
			const wrongUsername = new Uint8Array(username);
			wrongUsername[0] ^= 0x01;

			const password = encoder.encode(env.SOCKS5_PASSWORD);

			await negotiateUsernamePassword(client, inbox, wrongUsername, password);
			await expectMessage(inbox, [0x01, 0x01]);
			expect(await inbox.next(5000)).toBeNull();
			expect(inbox.closeEvent?.code).toBe(1008);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}

			await waitOnExecutionContext(context);
		}
	});

	it('returns 404 outside the configured tunnel path', async () => {
		const response = await SELF.fetch(`https://example.com${env.TUNNEL_PATH}__not_found__`);

		expect(response.status).toBe(404);
	});
});
