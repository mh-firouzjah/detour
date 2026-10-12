import { connect } from 'cloudflare:sockets';

export interface TcpSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	opened: Promise<unknown>;
	closed: Promise<void>;
	close(): Promise<void>;
}

export type TcpDialer = (hostname: string, port: number) => TcpSocket | Promise<TcpSocket>;

export const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 3000;
export const MIN_TCP_CONNECT_TIMEOUT_MS = 500;
export const MAX_TCP_CONNECT_TIMEOUT_MS = 10_000;

export function resolveTcpConnectTimeoutMs(value: string | undefined): number {
	if (value === undefined || value.trim() === '') {
		return DEFAULT_TCP_CONNECT_TIMEOUT_MS;
	}

	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) {
		return DEFAULT_TCP_CONNECT_TIMEOUT_MS;
	}

	const timeoutMs = Number(normalized);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TCP_CONNECT_TIMEOUT_MS || timeoutMs > MAX_TCP_CONNECT_TIMEOUT_MS) {
		return DEFAULT_TCP_CONNECT_TIMEOUT_MS;
	}

	return timeoutMs;
}

function assertValidTimeout(timeoutMs: number): void {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError('TCP connect timeout must be a positive safe integer');
	}
}

/**
 * Adds a deadline only to socket opening. Once opened, the socket can remain
 * active for as long as the tunnel needs it. The returned close operation is
 * idempotent so timeout and session cleanup cannot close the socket twice.
 */
export function withTcpOpenTimeout(socket: TcpSocket, timeoutMs = DEFAULT_TCP_CONNECT_TIMEOUT_MS): TcpSocket {
	assertValidTimeout(timeoutMs);

	// A socket may fail before a bridge attaches to `closed`. Mark the promise
	// handled now; consumers can still observe its original rejection later.
	void socket.closed.catch(() => undefined);

	let resolveOpened!: (value: unknown) => void;
	let rejectOpened!: (reason?: unknown) => void;
	let openingSettled = false;
	let closePromise: Promise<void> | undefined;

	const opened = new Promise<unknown>((resolve, reject) => {
		resolveOpened = resolve;
		rejectOpened = reject;
	});

	function resolveOpening(value: unknown): void {
		if (openingSettled) {
			return;
		}

		openingSettled = true;
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		resolveOpened(value);
	}

	function rejectOpening(reason: unknown): void {
		if (openingSettled) {
			return;
		}

		openingSettled = true;
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		rejectOpened(reason);
	}

	function closeUnderlying(): Promise<void> {
		closePromise ??= Promise.resolve().then(() => socket.close());
		return closePromise;
	}

	const timeoutHandle = setTimeout(() => {
		rejectOpening(new Error(`TCP socket did not open within ${timeoutMs} ms`));
		void closeUnderlying().catch(() => undefined);
	}, timeoutMs);
	socket.opened.then(resolveOpening, rejectOpening);

	return {
		readable: socket.readable,
		writable: socket.writable,
		opened,
		closed: socket.closed,
		close() {
			if (!openingSettled) {
				rejectOpening(new Error('TCP socket closed before opening'));
			}
			return closeUnderlying();
		},
	};
}

export function dialTcp(hostname: string, port: number, timeoutMs = DEFAULT_TCP_CONNECT_TIMEOUT_MS): TcpSocket {
	assertValidTimeout(timeoutMs);
	const socket = connect({ hostname, port }, { allowHalfOpen: true });
	return withTcpOpenTimeout(socket, timeoutMs);
}
