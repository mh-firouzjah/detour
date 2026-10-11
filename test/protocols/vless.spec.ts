import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { parseVlessRequest, parseVlessUuid } from '../../src/protocols/vless';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type VlessTestEnvironment = {
	VLESS_PATH?: string;
	VLESS_UUID?: string;
};

type MessageInbox = {
	next(timeoutMs?: number): Promise<Uint8Array | null>;
	readonly closeEvent: CloseEvent | undefined;
};

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function uuidBytes(value: string): Uint8Array {
	const hex = value.replaceAll('-', '');

	if (!/^[0-9a-f]{32}$/i.test(hex)) {
		throw new Error('VLESS_UUID is not a canonical UUID');
	}

	return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function makeVlessRequest(uuid: Uint8Array, hostname: string, payload = new Uint8Array(0)): Uint8Array {
	const domain = new TextEncoder().encode(hostname);

	if (domain.byteLength > 255) {
		throw new RangeError('VLESS domain name is too long');
	}

	return concatenate(new Uint8Array([0]), uuid, new Uint8Array([0, 1, 0, 80, 2, domain.byteLength]), domain, payload);
}

function createMessageInbox(socket: WebSocket): MessageInbox {
	const messages: Uint8Array[] = [];
	const waiters: {
		resolve(value: Uint8Array | null): void;
		reject(error: Error): void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

	let closed = false;
	let failure: Error | undefined;
	let closeEvent: CloseEvent | undefined;

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

		const message = new Uint8Array(event.data);
		const waiter = waiters.shift();

		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		} else {
			messages.push(message);
		}
	});

	socket.addEventListener('error', () => {
		fail(new Error('WebSocket client error'));
	});

	socket.addEventListener('close', (event: CloseEvent) => {
		closeEvent = event;
		closed = true;

		while (waiters.length > 0) {
			const waiter = waiters.shift()!;
			clearTimeout(waiter.timer);
			waiter.resolve(null);
		}
	});

	return {
		next(timeoutMs = 5000): Promise<Uint8Array | null> {
			if (messages.length > 0) {
				return Promise.resolve(messages.shift()!);
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
		get closeEvent() {
			return closeEvent;
		},
	};
}

async function openVlessTunnel(): Promise<{
	client: WebSocket;
	inbox: MessageInbox;
	context: ReturnType<typeof createExecutionContext>;
	uuid: string;
}> {
	const configured = env as unknown as VlessTestEnvironment;
	const path = configured.VLESS_PATH;
	const uuid = configured.VLESS_UUID;

	if (!path || !uuid) {
		throw new Error('VLESS_PATH and VLESS_UUID must be configured in .dev.vars');
	}

	const context = createExecutionContext();
	const response = await worker.fetch(
		new IncomingRequest(`https://example.com${path}`, {
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
		uuid,
	};
}

describe('VLESS protocol parser', () => {
	const sampleUuid = '00112233-4455-4677-8899-aabbccddeeff';
	const sampleUuidBytes = parseVlessUuid(sampleUuid);

	if (!sampleUuidBytes) {
		throw new Error('Invalid fixed UUID fixture');
	}

	it('waits for fragmented headers and preserves coalesced payload bytes', () => {
		const payload = new TextEncoder().encode('early payload');
		const request = makeVlessRequest(sampleUuidBytes, 'example.com', payload);

		expect(parseVlessRequest(request.subarray(0, 9), sampleUuidBytes)).toEqual({
			status: 'pending',
		});

		const parsed = parseVlessRequest(request, sampleUuidBytes);

		expect(parsed.status).toBe('complete');

		if (parsed.status === 'complete') {
			expect(parsed.request.hostname).toBe('example.com');
			expect(parsed.request.port).toBe(80);
			expect(Array.from(parsed.request.remaining)).toEqual(Array.from(payload));
		}
	});

	it('rejects unsupported addons without trying to interpret them', () => {
		const request = concatenate(new Uint8Array([0]), sampleUuidBytes, new Uint8Array([1]));

		expect(parseVlessRequest(request, sampleUuidBytes)).toEqual({
			status: 'rejected',
			reason: 'unsupported-addons',
		});
	});
});

describe('VLESS Worker integration', () => {
	it('authenticates by UUID and relays a real HTTP response from example.com', async () => {
		const { client, inbox, context, uuid } = await openVlessTunnel();
		const padding = 'a'.repeat(512);
		const payload = new TextEncoder().encode(
			`GET / HTTP/1.1\r\nHost: example.com\r\nX-Detour-Padding: ${padding}\r\nConnection: close\r\n\r\n`,
		);
		const wire = makeVlessRequest(uuidBytes(uuid), 'example.com', payload);

		try {
			// Split the header within the UUID; coalesce the HTTP request with the tail.
			client.send(wire.subarray(0, 9));
			client.send(wire.subarray(9));

			await expect(inbox.next(5000)).resolves.toEqual(new Uint8Array([0, 0]));

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

	it('closes a session with an invalid UUID before opening a TCP connection', async () => {
		const { client, inbox, context, uuid } = await openVlessTunnel();
		const invalidUuid = uuidBytes(uuid);
		invalidUuid[0] ^= 0xff;

		try {
			client.send(concatenate(new Uint8Array([0]), invalidUuid, new Uint8Array([0])));

			await expect(inbox.next(5000)).resolves.toBeNull();
			expect(inbox.closeEvent?.code).toBe(1008);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}

			await waitOnExecutionContext(context);
		}
	});
});
