import { connect } from 'cloudflare:sockets';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dialTcp } from '../../src/dialers/tcp';

vi.mock('cloudflare:sockets', () => ({
	connect: vi.fn(),
}));

const mockedConnect = vi.mocked(connect);

describe('TCP dialer', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it.each([
		['example.com', 443],
		['192.0.2.10', 8080],
		['2001:db8::10', 8443],
	])('passes destination %s:%i to connect unchanged with half-open mode', (hostname, port) => {
		const socket = {} as unknown as ReturnType<typeof connect>;
		mockedConnect.mockReturnValue(socket);

		expect(dialTcp(hostname, port)).toBe(socket);
		expect(mockedConnect.mock.calls).toEqual([[{ hostname, port }, { allowHalfOpen: true }]]);
	});

	it('propagates synchronous connection errors', () => {
		const failure = new Error('TCP connection failed');
		mockedConnect.mockImplementation(() => {
			throw failure;
		});

		expect(() => dialTcp('example.com', 443)).toThrow(failure);
	});
});
