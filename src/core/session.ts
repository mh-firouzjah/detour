import type { WebSocketCloseInfo, WebSocketTransport } from '../transports/websocket';

export type SessionContext = WebSocketTransport & {
	signal: AbortSignal;
};

export type SessionHandler = (session: SessionContext) => void | Promise<void>;

export type SessionResult =
	{ type: 'completed' } | { type: 'peer-closed'; closeInfo: WebSocketCloseInfo } | { type: 'handler-error'; error: unknown };

/**
 * Owns the lifecycle of one WebSocket session without knowing its protocol.
 *
 * The handler owns protocol processing and any resources it creates. It must
 * observe the abort signal and finish its cleanup when the peer disconnects.
 */
export async function runSession(transport: WebSocketTransport, handler: SessionHandler): Promise<SessionResult> {
	const abortController = new AbortController();
	const session: SessionContext = {
		...transport,
		signal: abortController.signal,
	};

	const handlerTask: Promise<SessionResult> = Promise.resolve()
		.then(() => handler(session))
		.then(
			() => ({ type: 'completed' }),
			(error: unknown) => ({ type: 'handler-error', error }),
		);

	const peerClosedTask: Promise<SessionResult> = transport.closed.then((closeInfo) => {
		abortController.abort(closeInfo);
		return { type: 'peer-closed', closeInfo };
	});

	const result = await Promise.race([handlerTask, peerClosedTask]);

	if (result.type === 'peer-closed') {
		// Allow the handler to observe EOF/abort and finish its cleanup.
		await handlerTask;
		return result;
	}

	abortController.abort(result.type === 'handler-error' ? result.error : result);

	if (result.type === 'handler-error') {
		transport.close(1011, 'Session handler failed');
	} else {
		transport.close(1000, 'Session completed');
	}

	return result;
}
