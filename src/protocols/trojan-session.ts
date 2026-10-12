import { dialTcp, type TcpDialer, type TcpSocket } from '../dialers/tcp';
import { startTcpBridge, type TcpBridge } from '../core/tcp-bridge';
import type { SessionHandler } from '../core/session';
import { hashTrojanPassword, MAX_TROJAN_HEADER_BYTES, parseTrojanRequest, type TrojanRequest } from './trojan';
import { startHandshakeDeadline } from './handshake-deadline';

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left);
	combined.set(right, left.byteLength);
	return combined;
}

function createAbortError(): Error {
	const error = new Error('Trojan session aborted');
	error.name = 'AbortError';
	return error;
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(createAbortError());
	}

	let abortHandler: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		abortHandler = () => reject(createAbortError());
		signal.addEventListener('abort', abortHandler, { once: true });

		if (signal.aborted) {
			abortHandler();
		}
	});

	return Promise.race([operation, aborted]).finally(() => {
		if (abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	});
}

async function writeWithAbort(writer: WritableStreamDefaultWriter<Uint8Array>, data: Uint8Array, signal: AbortSignal): Promise<void> {
	const writeTask = writer.write(data);

	try {
		await raceWithAbort(writeTask, signal);
	} catch (error) {
		// Closing the TCP socket should settle any pending write before its lock is released.
		if (signal.aborted) {
			await writeTask.catch(() => undefined);
		}

		throw error;
	}
}

async function closeSocketSafely(socket: TcpSocket): Promise<void> {
	await socket.close().catch(() => undefined);
}

export function createTrojanSessionHandler(password: string, dial: TcpDialer = dialTcp): SessionHandler {
	// Compute the password hash once per handler, not once per incoming chunk.
	const expectedPasswordHash = hashTrojanPassword(password);

	return async (session) => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = session.readable.getReader();
		const clearHandshakeDeadline = startHandshakeDeadline(session.close);
		let socket: TcpSocket | undefined;
		let bridge: TcpBridge | undefined;
		let abortCloseHandler: (() => void) | undefined;
		let socketClosePromise: Promise<void> | undefined;
		let discardLateSocket = false;

		const closeSocket = (): Promise<void> => {
			if (!socket) {
				return Promise.resolve();
			}

			socketClosePromise ??= Promise.resolve().then(() => socket!.close());
			return socketClosePromise;
		};

		try {
			let requestBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			let trailingPayload: Uint8Array | undefined;
			let request: TrojanRequest | undefined;

			while (true) {
				if (!reader) {
					throw new Error('Trojan reader is no longer available');
				}

				const result = await reader.read();

				if (result.done) {
					if (requestBuffer.byteLength > 0) {
						session.close(1002, 'Incomplete Trojan request');
					}
					return;
				}

				// Copy only the bounded request prefix; keep any large appended payload in the original chunk.
				const bytesToAppend = Math.min(result.value.byteLength, MAX_TROJAN_HEADER_BYTES - requestBuffer.byteLength);
				requestBuffer = appendBytes(requestBuffer, result.value.subarray(0, bytesToAppend));

				const parsed = parseTrojanRequest(requestBuffer, expectedPasswordHash);

				if (parsed.status === 'pending') {
					if (requestBuffer.byteLength >= MAX_TROJAN_HEADER_BYTES) {
						session.close(1002, 'Incomplete Trojan request header');
						return;
					}
					continue;
				}

				if (parsed.status === 'rejected') {
					const invalidPassword = parsed.reason === 'invalid-password';
					session.close(invalidPassword ? 1008 : 1002, invalidPassword ? 'Invalid Trojan password' : 'Invalid Trojan request');
					return;
				}

				request = parsed.request;
				if (bytesToAppend < result.value.byteLength) {
					trailingPayload = result.value.subarray(bytesToAppend);
				}
				break;
			}

			if (!request) {
				throw new Error('Trojan request parsing finished without a complete request');
			}

			clearHandshakeDeadline();

			const completeRequest = request;
			const pendingDial = Promise.resolve().then(() => dial(completeRequest.hostname, completeRequest.port));
			void pendingDial.then(
				(lateSocket) => {
					if (discardLateSocket || session.signal.aborted) {
						void closeSocketSafely(lateSocket);
					}
				},
				() => undefined,
			);

			try {
				socket = await raceWithAbort(pendingDial, session.signal);
			} catch {
				discardLateSocket = true;
				if (!session.signal.aborted) {
					session.close(1011, 'TCP connection failed');
				}
				return;
			}

			abortCloseHandler = () => {
				void closeSocket().catch(() => undefined);
			};
			session.signal.addEventListener('abort', abortCloseHandler, { once: true });

			if (session.signal.aborted) {
				abortCloseHandler();
			}

			try {
				await raceWithAbort(Promise.resolve(socket.opened), session.signal);
			} catch {
				if (!session.signal.aborted) {
					session.close(1011, 'TCP connection failed');
				}
				return;
			}

			if (session.signal.aborted) {
				return;
			}

			// Release the parser's reader before the bridge acquires the same readable stream.
			reader.releaseLock();
			reader = undefined;

			if (request.remaining.byteLength > 0 || (trailingPayload?.byteLength ?? 0) > 0) {
				const tcpWriter = socket.writable.getWriter();

				try {
					if (request.remaining.byteLength > 0) {
						await writeWithAbort(tcpWriter, request.remaining, session.signal);
					}

					if (trailingPayload && trailingPayload.byteLength > 0) {
						await writeWithAbort(tcpWriter, trailingPayload, session.signal);
						trailingPayload = undefined;
					}
				} finally {
					tcpWriter.releaseLock();
				}
			}

			if (session.signal.aborted) {
				return;
			}

			if (abortCloseHandler) {
				session.signal.removeEventListener('abort', abortCloseHandler);
				abortCloseHandler = undefined;
			}

			// The bridge takes over socket cleanup from this point onward.
			socketClosePromise = undefined;
			bridge = startTcpBridge(session, socket);

			// The WebSocket byte stream has no explicit TCP half-close frame.
			const result = await Promise.race([bridge.webSocketToTcp, bridge.tcpToWebSocket]);

			if (result.type !== 'completed') {
				throw result.error;
			}
		} finally {
			clearHandshakeDeadline();
			if (abortCloseHandler) {
				session.signal.removeEventListener('abort', abortCloseHandler);
			}

			reader?.releaseLock();

			if (bridge) {
				await bridge.close().catch(() => undefined);
			} else if (socket) {
				await closeSocket().catch(() => undefined);
			}
		}
	};
}
