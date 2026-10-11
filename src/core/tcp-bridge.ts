import type { TcpSocket } from '../dialers/tcp';
import { forwardReadable, type ForwardResult } from './duplex';
import type { SessionContext } from './session';

export type TcpSocketCloseResult = { type: 'closed' } | { type: 'error'; error: unknown };

export interface TcpBridge {
	webSocketToTcp: Promise<ForwardResult>;
	tcpToWebSocket: Promise<ForwardResult>;
	socketClosed: Promise<TcpSocketCloseResult>;
	close(): Promise<void>;
}

/**
 * Starts byte forwarding for an already-open TCP socket.
 *
 * Each direction reports its own result. EOF or an error in one direction
 * does not automatically terminate the other direction or the whole session.
 * The caller owns that policy and should call close() when the bridge is done.
 * Aborting the owning session closes the TCP socket to prevent resource leaks.
 */
export function startTcpBridge(session: Pick<SessionContext, 'readable' | 'writable' | 'signal'>, socket: TcpSocket): TcpBridge {
	const tcpWriter = socket.writable.getWriter();
	const webSocketWriter = session.writable.getWriter();

	let closePromise: Promise<void> | undefined;

	const close = (): Promise<void> => {
		if (closePromise === undefined) {
			session.signal.removeEventListener('abort', onAbort);
			closePromise = Promise.resolve().then(() => socket.close());
		}

		return closePromise;
	};

	const onAbort = (): void => {
		void close().catch(() => undefined);
	};

	const socketClosed = socket.closed.then(
		() => ({ type: 'closed' as const }),
		(error: unknown) => ({ type: 'error' as const, error }),
	);

	const webSocketToTcp = forwardReadable(session.readable, (chunk) => tcpWriter.write(chunk)).finally(() => {
		tcpWriter.releaseLock();
	});

	const tcpToWebSocket = forwardReadable(socket.readable, (chunk) => webSocketWriter.write(chunk)).finally(() => {
		webSocketWriter.releaseLock();
	});

	session.signal.addEventListener('abort', onAbort, { once: true });

	if (session.signal.aborted) {
		onAbort();
	}

	return {
		webSocketToTcp,
		tcpToWebSocket,
		socketClosed,
		close,
	};
}
