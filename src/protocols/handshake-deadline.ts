export const HANDSHAKE_TIMEOUT_MS = 5000;

export function startHandshakeDeadline(close: (code: number, reason: string) => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
		timer = undefined;
		close(1008, 'Handshake timeout');
	}, HANDSHAKE_TIMEOUT_MS);

	return () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
}
