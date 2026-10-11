import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { hashTrojanPassword } from '../../src/protocols/trojan';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type TrojanTestEnvironment = {
	TROJAN_PATH?: string;
	TROJAN_PASSWORD?: string;
};

type ClosedWebSocketData = {
	bytes: Uint8Array;
	closeEvent: CloseEvent;
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

function makeTrojanRequest(password: string, hostname: string, port: number, payload: Uint8Array): Uint8Array {
	const passwordHash = new TextEncoder().encode(hashTrojanPassword(password));
	const domain = new TextEncoder().encode(hostname);

	if (domain.byteLength === 0 || domain.byteLength > 255) {
		throw new RangeError('Trojan test domain must fit in one length-prefixed address');
	}

	return concatenate(
		passwordHash,
		new Uint8Array([0x0d, 0x0a]),
		new Uint8Array([0x01, 0x03, domain.byteLength]),
		domain,
		new Uint8Array([(port >>> 8) & 0xff, port & 0xff, 0x0d, 0x0a]),
		payload,
	);
}

function receiveUntilClose(socket: WebSocket, timeoutMs = 15000): Promise<ClosedWebSocketData> {
	return new Promise<ClosedWebSocketData>((resolve, reject) => {
		const chunks: Uint8Array[] = [];

		const cleanup = (): void => {
			clearTimeout(timer);
			socket.removeEventListener('message', onMessage);
			socket.removeEventListener('error', onError);
			socket.removeEventListener('close', onClose);
		};

		const fail = (error: Error): void => {
			cleanup();
			reject(error);
		};

		const onMessage = (event: MessageEvent): void => {
			if (!(event.data instanceof ArrayBuffer)) {
				fail(new Error('Expected binary WebSocket message'));
				return;
			}

			const chunk = new Uint8Array(event.data);
			chunks.push(chunk);
		};

		const onError = (): void => fail(new Error('WebSocket client error'));

		const onClose = (event: CloseEvent): void => {
			cleanup();
			resolve({ bytes: concatenate(...chunks), closeEvent: event });
		};

		const timer = setTimeout(() => fail(new Error(`Timed out after ${timeoutMs} ms waiting for WebSocket close`)), timeoutMs);
		socket.addEventListener('message', onMessage);
		socket.addEventListener('error', onError);
		socket.addEventListener('close', onClose);
	});
}

async function openTrojanTunnel(): Promise<{
	client: WebSocket;
	context: ReturnType<typeof createExecutionContext>;
	password: string;
}> {
	const configured = env as unknown as TrojanTestEnvironment;
	const path = configured.TROJAN_PATH;
	const password = configured.TROJAN_PASSWORD;

	if (!path || !password) {
		throw new Error('TROJAN_PATH and TROJAN_PASSWORD must be configured in .dev.vars');
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

	return { client, context, password };
}

describe('Trojan Worker integration', () => {
	it('authenticates, CONNECTs to a real Internet host, and relays its HTTP response', async () => {
		const { client, context, password } = await openTrojanTunnel();
		const receiving = receiveUntilClose(client);
		const payload = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');

		try {
			client.send(makeTrojanRequest(password, 'example.com', 80, payload));
			const result = await receiving;
			const response = new TextDecoder().decode(result.bytes);

			expect(response).toMatch(/^HTTP\/1\.[01] 200\b/);
			expect(result.closeEvent.code).toBe(1000);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			await waitOnExecutionContext(context);
		}
	});

	it('rejects an incorrect password before relaying target data', async () => {
		const { client, context, password } = await openTrojanTunnel();
		const receiving = receiveUntilClose(client, 5000);

		try {
			client.send(makeTrojanRequest(`${password}-incorrect`, 'example.com', 80, new Uint8Array(0)));
			const result = await receiving;

			expect(result.bytes.byteLength).toBe(0);
			expect(result.closeEvent.code).toBe(1008);
		} finally {
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				client.close(1000, 'Test cleanup');
			}
			await waitOnExecutionContext(context);
		}
	});
});
