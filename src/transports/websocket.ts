export type WebSocketCloseInfo = {
	code: number;
	reason: string;
	wasClean: boolean;
};

export type WebSocketTransportOptions = {
	maxQueuedIncomingBytes: number;
};

export type WebSocketTransport = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	closed: Promise<WebSocketCloseInfo>;
	close(code?: number, reason?: string): void;
};

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function toError(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback);
}

/**
 * Adapts an accepted WebSocket to byte streams.
 *
 * This module knows nothing about application protocols or TCP destinations.
 * Configure it before accepting the WebSocket so listeners and binaryType
 * are ready before messages start arriving.
 *
 * Incoming messages are queued only up to maxQueuedIncomingBytes.
 * Cloudflare Workers does not expose WebSocket.bufferedAmount, so this
 * adapter cannot measure the runtime's outgoing network buffer.
 *
 * WritableStream serializes writes. Await writer.write() to avoid building
 * an application-side backlog. This does not guarantee network-level
 * backpressure because WebSocket.send() has no drain promise in Workers.
 *
 * WebSocket has no independent half-close operation. Closing this transport
 * closes the underlying WebSocket connection.
 */
export function attachWebSocketTransport(webSocket: WebSocket, options: WebSocketTransportOptions): WebSocketTransport {
	assertPositiveSafeInteger(options.maxQueuedIncomingBytes, 'maxQueuedIncomingBytes');

	webSocket.binaryType = 'arraybuffer';

	let readableController!: ReadableStreamDefaultController<Uint8Array>;
	let readPending = false;
	let queuedIncomingBytes = 0;
	let readableTerminated = false;

	const incomingQueue: Uint8Array[] = [];

	let failure: Error | undefined;
	let closeRequested = false;
	let socketClosed = false;

	let resolveClosed!: (info: WebSocketCloseInfo) => void;
	const closed = new Promise<WebSocketCloseInfo>((resolve) => {
		resolveClosed = resolve;
	});

	function terminateReadable(error?: Error): void {
		if (readableTerminated) {
			return;
		}

		readableTerminated = true;
		readPending = false;

		try {
			if (error) {
				readableController.error(error);
			} else {
				readableController.close();
			}
		} catch {
			// The readable stream may already be cancelled or terminal.
		}
	}

	function detachListeners(): void {
		webSocket.removeEventListener('message', onMessage);
		webSocket.removeEventListener('close', onClose);
		webSocket.removeEventListener('error', onError);
	}

	function requestClose(code: number, reason: string): void {
		if (closeRequested || socketClosed) {
			return;
		}

		closeRequested = true;
		incomingQueue.length = 0;
		queuedIncomingBytes = 0;

		if (failure === undefined) {
			terminateReadable();
		}

		if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
			try {
				webSocket.close(code, reason);
			} catch (error) {
				if (failure === undefined) {
					failure = toError(error, 'WebSocket close failed');
					terminateReadable(failure);
				}
			}
		}
	}

	function fail(error: Error, code: number, reason: string): void {
		if (failure !== undefined || socketClosed) {
			return;
		}

		failure = error;
		incomingQueue.length = 0;
		queuedIncomingBytes = 0;

		terminateReadable(error);
		requestClose(code, reason);
	}

	function onMessage(event: MessageEvent): void {
		if (socketClosed || closeRequested || failure !== undefined || readableTerminated) {
			return;
		}

		if (!(event.data instanceof ArrayBuffer)) {
			fail(new Error('Expected a binary WebSocket message'), 1003, 'Binary messages required');
			return;
		}

		const data = new Uint8Array(event.data);

		if (data.byteLength === 0) {
			return;
		}

		if (readPending) {
			readPending = false;
			readableController.enqueue(data);
			return;
		}

		if (queuedIncomingBytes + data.byteLength > options.maxQueuedIncomingBytes) {
			fail(new Error('Incoming WebSocket queue limit exceeded'), 1013, 'Consumer is overloaded');
			return;
		}

		incomingQueue.push(data);
		queuedIncomingBytes += data.byteLength;
	}

	function onClose(event: CloseEvent): void {
		if (socketClosed) {
			return;
		}

		socketClosed = true;
		closeRequested = true;

		// Drain complete messages received before Close. Once the queue is
		// empty, the next read observes socketClosed and ends the stream.
		if (incomingQueue.length === 0) {
			terminateReadable(failure);
		}

		resolveClosed({
			code: event.code,
			reason: event.reason,
			wasClean: event.wasClean,
		});

		detachListeners();
	}

	function onError(): void {
		fail(new Error('WebSocket transport error'), 1011, 'WebSocket transport error');
	}

	const readable = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				readableController = controller;
			},

			pull(controller) {
				if (failure !== undefined) {
					terminateReadable(failure);
					return;
				}

				if (incomingQueue.length > 0) {
					const data = incomingQueue.shift()!;
					queuedIncomingBytes -= data.byteLength;
					controller.enqueue(data);
					return;
				}

				if (socketClosed || closeRequested) {
					terminateReadable();
					return;
				}

				readPending = true;
			},

			cancel() {
				requestClose(1000, 'WebSocket input cancelled');
			},
		},
		{ highWaterMark: 0 },
	);

	const writable = new WritableStream<Uint8Array>(
		{
			write(data) {
				if (!(data instanceof Uint8Array)) {
					throw new TypeError('Expected Uint8Array');
				}

				if (data.byteLength === 0) {
					return;
				}

				if (failure !== undefined || socketClosed || closeRequested || webSocket.readyState !== WebSocket.OPEN) {
					throw failure ?? new Error('WebSocket is not open');
				}

				try {
					webSocket.send(data);
				} catch (error) {
					const sendError = toError(error, 'WebSocket send failed');
					fail(sendError, 1011, 'WebSocket send failed');
					throw sendError;
				}
			},

			close() {
				requestClose(1000, 'WebSocket byte stream completed');
			},

			abort(reason) {
				fail(toError(reason, 'WebSocket writable stream aborted'), 1011, 'WebSocket output aborted');
			},
		},
		{
			// This bounds the Streams API's desired size in bytes; it does
			// not measure or bound the Worker's internal network send buffer.
			highWaterMark: options.maxQueuedIncomingBytes,
			size: (data) => data.byteLength,
		},
	);

	webSocket.addEventListener('message', onMessage);
	webSocket.addEventListener('close', onClose);
	webSocket.addEventListener('error', onError);

	return {
		readable,
		writable,
		closed,

		close(code = 1000, reason = '') {
			requestClose(code, reason);
		},
	};
}
