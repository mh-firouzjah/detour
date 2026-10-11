export type ForwardResult =
	{ type: 'completed' } | { type: 'source-error'; error: unknown } | { type: 'destination-error'; error: unknown };

/**
 * Forwards byte chunks from a readable stream to a destination callback.
 *
 * This helper owns neither endpoint. It does not close the destination,
 * cancel the source, or decide whether a larger session should terminate.
 * The caller owns that lifecycle policy.
 *
 * Completion and failures are reported separately so a session coordinator
 * can apply its own protocol and connection-lifecycle rules.
 */
export async function forwardReadable(
	source: ReadableStream<Uint8Array>,
	write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<ForwardResult> {
	const reader = source.getReader();

	try {
		while (true) {
			let result: ReadableStreamReadResult<Uint8Array>;

			try {
				result = await reader.read();
			} catch (error) {
				return { type: 'source-error', error };
			}

			if (result.done) {
				return { type: 'completed' };
			}

			try {
				await write(result.value);
			} catch (error) {
				return { type: 'destination-error', error };
			}
		}
	} finally {
		reader.releaseLock();
	}
}
