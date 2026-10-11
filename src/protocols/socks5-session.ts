import { dialTcp, type TcpDialer, type TcpSocket } from '../dialers/tcp';
import { startTcpBridge, type TcpBridge } from '../core/tcp-bridge';
import type { SessionHandler } from '../core/session';
import {
	Socks5Negotiator,
	Socks5RequestError,
	encodeSocks5Reply,
	parseSocks5ConnectRequest,
	type Socks5NegotiationRejection,
	type Socks5ConnectRequest,
} from './socks5';

const NEGOTIATION_CLOSE_DETAILS: Record<Socks5NegotiationRejection, { code: number; reason: string }> = {
	'unsupported-version': { code: 1002, reason: 'Unsupported SOCKS version' },
	'no-acceptable-method': { code: 1000, reason: 'No acceptable authentication method' },
	'invalid-authentication-version': { code: 1002, reason: 'Invalid authentication version' },
	'invalid-credentials': { code: 1008, reason: 'Invalid credentials' },
};

export function areValidSocks5Credentials(username: string | undefined, password: string | undefined): boolean {
	if (!username || !password) {
		return false;
	}

	const encoder = new TextEncoder();
	const usernameBytes = encoder.encode(username);
	const passwordBytes = encoder.encode(password);

	return usernameBytes.byteLength > 0 && usernameBytes.byteLength <= 255 && passwordBytes.byteLength > 0 && passwordBytes.byteLength <= 255;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left);
	combined.set(right, left.byteLength);
	return combined;
}

export function createSocks5SessionHandler(username: string, password: string, dial: TcpDialer = dialTcp): SessionHandler {
	if (!areValidSocks5Credentials(username, password)) {
		throw new RangeError('SOCKS5 username and password must each be 1–255 UTF-8 bytes');
	}

	return async (session) => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = session.readable.getReader();
		let webSocketWriter: WritableStreamDefaultWriter<Uint8Array> | undefined = session.writable.getWriter();
		let socket: TcpSocket | undefined;
		let bridge: TcpBridge | undefined;

		const readNext = async (): Promise<Uint8Array | undefined> => {
			if (!reader) {
				throw new Error('SOCKS5 reader is no longer available');
			}

			const result = await reader.read();
			return result.done ? undefined : result.value;
		};

		const writeToWebSocket = async (data: Uint8Array): Promise<void> => {
			if (!webSocketWriter) {
				throw new Error('SOCKS5 writer is no longer available');
			}

			await webSocketWriter.write(data);
		};

		try {
			const negotiator = new Socks5Negotiator(username, password);
			let requestBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			let negotiated = false;

			while (!negotiated) {
				const data = await readNext();
				if (!data) {
					return;
				}

				const step = negotiator.feed(data);

				for (const reply of step.replies) {
					await writeToWebSocket(reply);
				}

				if (step.status === 'pending') {
					continue;
				}

				if (step.status === 'rejected') {
					const details = NEGOTIATION_CLOSE_DETAILS[step.reason];
					session.close(details.code, details.reason);
					return;
				}

				requestBuffer = step.remaining;
				negotiated = true;
			}

			let request: Socks5ConnectRequest | null = null;

			while (request === null) {
				try {
					request = parseSocks5ConnectRequest(requestBuffer);
				} catch (error) {
					if (!(error instanceof Socks5RequestError)) {
						throw error;
					}

					await writeToWebSocket(encodeSocks5Reply(error.replyCode));
					return;
				}

				if (request !== null) {
					break;
				}

				const data = await readNext();
				if (!data) {
					return;
				}

				requestBuffer = appendBytes(requestBuffer, data);
			}

			try {
				socket = await dial(request.hostname, request.port);
				await socket.opened;
			} catch {
				await writeToWebSocket(encodeSocks5Reply(0x01));
				return;
			}

			await writeToWebSocket(encodeSocks5Reply(0x00));

			reader.releaseLock();
			reader = undefined;

			webSocketWriter.releaseLock();
			webSocketWriter = undefined;

			if (request.remaining.byteLength > 0) {
				const writer = socket.writable.getWriter();

				try {
					await writer.write(request.remaining);
				} finally {
					writer.releaseLock();
				}
			}

			bridge = startTcpBridge(session, socket);

			// Raw SOCKS5 over WebSocket has no control frame for TCP
			// half-close, so EOF ends this one-to-one tunnel session.
			const result = await Promise.race([bridge.webSocketToTcp, bridge.tcpToWebSocket]);

			if (result.type !== 'completed') {
				throw result.error;
			}
		} finally {
			reader?.releaseLock();
			webSocketWriter?.releaseLock();

			if (bridge) {
				await bridge.close().catch(() => undefined);
			} else if (socket) {
				try {
					await socket.close();
				} catch {
					// The socket may already have closed after a connection error.
				}
			}
		}
	};
}
