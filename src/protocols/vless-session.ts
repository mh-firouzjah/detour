import { dialTcp, type TcpDialer, type TcpSocket } from '../dialers/tcp';
import { startTcpBridge, type TcpBridge } from '../core/tcp-bridge';
import type { SessionHandler } from '../core/session';
import { startHandshakeDeadline } from './handshake-deadline';
import { isValidVlessUuid, parseVlessRequest, parseVlessUuid, type VlessRequest } from './vless';

// Addons are currently unsupported, so the largest accepted VLESS header is
// version + UUID + addons length + command + port + address type + domain.
const MAX_VLESS_HEADER_BYTES = 1 + 16 + 1 + 1 + 2 + 1 + 1 + 255;

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left);
	combined.set(right, left.byteLength);
	return combined;
}

class SessionAbortedError extends Error {
	constructor() {
		super('VLESS session aborted');
		this.name = 'SessionAbortedError';
	}
}

function waitForSessionOperation<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;

		const cleanup = (): void => {
			signal.removeEventListener('abort', onAbort);
		};

		const onAbort = (): void => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			reject(new SessionAbortedError());
		};

		signal.addEventListener('abort', onAbort, { once: true });

		// Keep rejection handlers attached even if abort wins the race, so a
		// later rejection from an opening socket or dialer is never unhandled.
		void Promise.resolve(operation).then(
			(value) => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				reject(error);
			},
		);

		if (signal.aborted) {
			onAbort();
		}
	});
}

export function createVlessSessionHandler(uuid: string, dial: TcpDialer = dialTcp): SessionHandler {
	const expectedUuid = parseVlessUuid(uuid);

	if (!isValidVlessUuid(uuid) || !expectedUuid) {
		throw new RangeError('VLESS UUID must use the canonical 36-character UUID format');
	}

	return async (session) => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = session.readable.getReader();
		let webSocketWriter: WritableStreamDefaultWriter<Uint8Array> | undefined = session.writable.getWriter();
		const clearHandshakeDeadline = startHandshakeDeadline(session.close);
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

		try {
			let requestBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			let request: VlessRequest | undefined;
			let trailingPayload: Uint8Array | undefined;

			while (true) {
				if (!reader) {
					throw new Error('VLESS reader is no longer available');
				}

				const result = await reader.read();

				if (result.done) {
					return;
				}

				// Copy only a bounded header prefix. A single WebSocket message can
				// contain a very large payload; copying the whole message here would
				// temporarily duplicate that payload in Worker memory.
				const bytesToAppend = Math.min(result.value.byteLength, MAX_VLESS_HEADER_BYTES - requestBuffer.byteLength);
				requestBuffer = appendBytes(requestBuffer, result.value.subarray(0, bytesToAppend));

				const parsed = parseVlessRequest(requestBuffer, expectedUuid);

				if (parsed.status === 'pending') {
					if (requestBuffer.byteLength >= MAX_VLESS_HEADER_BYTES) {
						// With addons rejected, no valid header can exceed this size.
						session.close(1002, 'Incomplete VLESS request header');
						return;
					}

					continue;
				}

				if (parsed.status === 'rejected') {
					const unauthorized = parsed.reason === 'invalid-uuid';
					session.close(unauthorized ? 1008 : 1002, unauthorized ? 'Invalid VLESS UUID' : 'Unsupported VLESS request');
					return;
				}

				request = parsed.request;
				if (bytesToAppend < result.value.byteLength) {
					trailingPayload = result.value.subarray(bytesToAppend);
				}
				break;
			}

			clearHandshakeDeadline();

			try {
				const dialTask = Promise.resolve()
					.then(() => {
						if (session.signal.aborted) {
							throw new SessionAbortedError();
						}

						return dial(request.hostname, request.port);
					})
					.then((connectedSocket) => {
						// Record the socket inside the dial task so a socket that
						// arrives after abort can still be closed by the cleanup path.
						socket = connectedSocket;
						abortCloseHandler = () => {
							void closeSocket().catch(() => undefined);
						};
						session.signal.addEventListener('abort', abortCloseHandler, { once: true });

						if (session.signal.aborted) {
							abortCloseHandler();
						}

						return connectedSocket;
					});

				socket = await waitForSessionOperation(dialTask, session.signal);
				await waitForSessionOperation(socket.opened, session.signal);
			} catch {
				if (!session.signal.aborted) {
					session.close(1011, 'TCP connection failed');
				}
				return;
			}

			if (session.signal.aborted) {
				return;
			}

			if (!webSocketWriter) {
				throw new Error('VLESS WebSocket writer is no longer available');
			}

			// VLESS response header: request version and zero response addons.
			await waitForSessionOperation(webSocketWriter.write(new Uint8Array([request.version, 0])), session.signal);

			if (session.signal.aborted) {
				return;
			}

			reader.releaseLock();
			reader = undefined;

			webSocketWriter.releaseLock();
			webSocketWriter = undefined;

			if (request.remaining.byteLength > 0 || (trailingPayload?.byteLength ?? 0) > 0) {
				const tcpWriter = socket.writable.getWriter();

				try {
					if (request.remaining.byteLength > 0) {
						if (session.signal.aborted) {
							return;
						}

						await waitForSessionOperation(tcpWriter.write(request.remaining), session.signal);
					}

					if (trailingPayload && trailingPayload.byteLength > 0) {
						if (session.signal.aborted) {
							return;
						}

						await waitForSessionOperation(tcpWriter.write(trailingPayload), session.signal);
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

			// After bridge creation, the bridge owns TCP cleanup.
			socketClosePromise = undefined;
			bridge = startTcpBridge(session, socket);

			// This raw WebSocket transport has no explicit half-close frame.
			// The session ends when either byte stream reaches EOF or fails.
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
			webSocketWriter?.releaseLock();

			if (bridge) {
				await bridge.close().catch(() => undefined);
			} else if (socket) {
				await closeSocket().catch(() => undefined);
			}
		}
	};
}
