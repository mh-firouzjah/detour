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

function waitForSocketOpen(opened: Promise<unknown>, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;

		const cleanup = (): void => {
			signal.removeEventListener('abort', onAbort);
		};

		const finish = (error?: unknown): void => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();

			if (error !== undefined) {
				reject(error);
			} else {
				resolve();
			}
		};

		const onAbort = (): void => {
			finish(new Error('Session closed while TCP was opening'));
		};

		signal.addEventListener('abort', onAbort, { once: true });
		void opened.then(
			() => finish(),
			(error: unknown) => finish(error),
		);

		if (signal.aborted) {
			onAbort();
		}
	});
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
		let abortCloseHandler: (() => void) | undefined;
		let socketClosePromise: Promise<void> | undefined;

		const closeSocket = (): Promise<void> => {
			if (!socket) {
				return Promise.resolve();
			}

			socketClosePromise ??= Promise.resolve().then(() => socket!.close());
			return socketClosePromise;
		};

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
				abortCloseHandler = () => {
					void closeSocket().catch(() => undefined);
				};
				session.signal.addEventListener('abort', abortCloseHandler, { once: true });

				if (session.signal.aborted) {
					abortCloseHandler();
				}
				await waitForSocketOpen(socket.opened, session.signal);
			} catch {
				if (!session.signal.aborted) {
					await writeToWebSocket(encodeSocks5Reply(0x01));
				}
				return;
			}

			if (session.signal.aborted) {
				return;
			}
			await writeToWebSocket(encodeSocks5Reply(0x00));

			if (session.signal.aborted) {
				return;
			}

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

			if (session.signal.aborted) {
				return;
			}

			if (abortCloseHandler) {
				session.signal.removeEventListener('abort', abortCloseHandler);
				abortCloseHandler = undefined;
			}
			bridge = startTcpBridge(session, socket);

			// Raw SOCKS5 over WebSocket has no control frame for TCP
			// half-close, so EOF ends this one-to-one tunnel session.
			const result = await Promise.race([bridge.webSocketToTcp, bridge.tcpToWebSocket]);

			if (result.type !== 'completed') {
				throw result.error;
			}
		} finally {
			if (abortCloseHandler) {
				session.signal.removeEventListener('abort', abortCloseHandler);
			}
			reader?.releaseLock();
			webSocketWriter?.releaseLock();

			if (bridge) {
				await bridge.close().catch(() => undefined);
			} else if (socket) {
				await closeSocket().catch(() => undefined);
			}
		}
	};
}
