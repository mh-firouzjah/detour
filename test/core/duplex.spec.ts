import { describe, expect, it } from 'vitest';
import { forwardReadable } from '../../src/core/duplex';

describe('forwardReadable', () => {
	it('forwards real stream chunks in order without changing their bytes', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0, 1, 255]));
				controller.enqueue(new Uint8Array([4, 5]));
				controller.close();
			},
		});

		const received: number[][] = [];

		const result = await forwardReadable(source, (chunk) => {
			received.push(Array.from(chunk));
		});

		expect(result).toEqual({ type: 'completed' });
		expect(received).toEqual([
			[0, 1, 255],
			[4, 5],
		]);
		expect(source.locked).toBe(false);
	});

	it('awaits each destination write before forwarding the next chunk', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.enqueue(new Uint8Array([2]));
				controller.close();
			},
		});

		const received: number[] = [];
		let releaseFirstWrite!: () => void;

		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});

		const resultPromise = forwardReadable(source, async (chunk) => {
			const value = chunk[0];
			if (value === 1) {
				await firstWriteGate;
			}
			received.push(value);
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(received).toEqual([]);

		releaseFirstWrite();

		await expect(resultPromise).resolves.toEqual({
			type: 'completed',
		});

		expect(received).toEqual([1, 2]);
	});

	it('reports normal EOF without closing the destination', async () => {
		let destinationClosed = false;
		const received: number[][] = [];

		const destination = new WritableStream<Uint8Array>({
			write(chunk) {
				received.push(Array.from(chunk));
			},
			close() {
				destinationClosed = true;
			},
		});

		const writer = destination.getWriter();

		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});

		try {
			const result = await forwardReadable(source, (chunk) => writer.write(chunk));

			expect(result).toEqual({ type: 'completed' });
			expect(destinationClosed).toBe(false);

			// The destination remains usable; lifecycle ownership stays
			// with the caller after this forwarding operation completes.
			await writer.write(new Uint8Array([9]));
			expect(received).toEqual([[1, 2, 3], [9]]);
		} finally {
			await writer.close();
			writer.releaseLock();
		}

		expect(destinationClosed).toBe(true);
	});

	it('reports a destination write error without cancelling the source', async () => {
		const failure = new Error('Destination write failed');
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.enqueue(new Uint8Array([2]));
			},
		});

		const result = await forwardReadable(source, () => {
			throw failure;
		});

		expect(result).toEqual({
			type: 'destination-error',
			error: failure,
		});
		expect(source.locked).toBe(false);

		const reader = source.getReader();
		try {
			await expect(reader.read()).resolves.toEqual({
				done: false,
				value: new Uint8Array([2]),
			});
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	});

	it('reports a source read error without writing to the destination', async () => {
		const failure = new Error('Source read failed');
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(failure);
			},
		});
		const received: Uint8Array[] = [];

		const result = await forwardReadable(source, (chunk) => {
			received.push(chunk);
		});

		expect(result).toEqual({
			type: 'source-error',
			error: failure,
		});
		expect(received).toEqual([]);
		expect(source.locked).toBe(false);
	});
});
