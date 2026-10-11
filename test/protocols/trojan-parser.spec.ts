import { describe, expect, it } from 'vitest';
import { hashTrojanPassword, parseTrojanRequest } from '../../src/protocols/trojan';

const CRLF = new Uint8Array([0x0d, 0x0a]);
const PASSWORD = 'test-password';
const PASSWORD_HASH = hashTrojanPassword(PASSWORD);

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function makeRequest(addressType: number, address: Uint8Array, port = 80, payload = new Uint8Array(0), password = PASSWORD): Uint8Array {
	const requestHeader = concatenate(new Uint8Array([0x01, addressType]), address, new Uint8Array([(port >>> 8) & 0xff, port & 0xff]), CRLF);

	return concatenate(new TextEncoder().encode(hashTrojanPassword(password)), CRLF, requestHeader, payload);
}

function domainAddress(hostname: string): Uint8Array {
	const bytes = new TextEncoder().encode(hostname);
	if (bytes.byteLength > 255) {
		throw new RangeError('Trojan domain name is too long');
	}

	return concatenate(new Uint8Array([bytes.byteLength]), bytes);
}

function expectRejected(data: Uint8Array, reason: string): void {
	expect(parseTrojanRequest(data, PASSWORD_HASH)).toEqual({ status: 'rejected', reason });
}

describe('Trojan password hash', () => {
	it('computes the standard SHA-224 hexadecimal digest', () => {
		expect(hashTrojanPassword('password')).toBe('d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01');
	});
});

describe('Trojan request parser boundary cases', () => {
	it('waits for every truncated prefix of a valid request header', () => {
		const payload = new Uint8Array([0, 13, 10, 255, 1]);
		const wire = makeRequest(0x03, domainAddress('example.com'), 443, payload);
		const headerLength = wire.byteLength - payload.byteLength;

		for (let offset = 0; offset < headerLength; offset += 1) {
			expect(parseTrojanRequest(wire.subarray(0, offset), PASSWORD_HASH)).toEqual({ status: 'pending' });
		}

		const parsed = parseTrojanRequest(wire, PASSWORD_HASH);
		expect(parsed.status).toBe('complete');
		if (parsed.status === 'complete') {
			expect(parsed.request.hostname).toBe('example.com');
			expect(parsed.request.port).toBe(443);
			expect(Array.from(parsed.request.remaining)).toEqual(Array.from(payload));
		}
	});

	it('parses IPv4 and preserves binary payload bytes', () => {
		const payload = new Uint8Array([0, 255, 13, 10, 128]);
		const parsed = parseTrojanRequest(makeRequest(0x01, new Uint8Array([192, 0, 2, 17]), 8443, payload), PASSWORD_HASH);

		expect(parsed).toMatchObject({ status: 'complete', request: { hostname: '192.0.2.17', port: 8443 } });
		if (parsed.status === 'complete') {
			expect(Array.from(parsed.request.remaining)).toEqual(Array.from(payload));
		}
	});

	it('parses IPv6 addresses', () => {
		const address = new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
		const parsed = parseTrojanRequest(makeRequest(0x04, address, 443), PASSWORD_HASH);

		expect(parsed).toMatchObject({ status: 'complete', request: { hostname: '2001:db8:0:0:0:0:0:1', port: 443 } });
	});

	it('accepts a maximum-length valid DNS name', () => {
		const hostname = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
		expect(hostname.length).toBe(253);
		const parsed = parseTrojanRequest(makeRequest(0x03, domainAddress(hostname)), PASSWORD_HASH);
		expect(parsed).toMatchObject({ status: 'complete', request: { hostname, port: 80 } });
	});

	it('rejects a wrong password hash', () => {
		expectRejected(makeRequest(0x03, domainAddress('example.com'), 80, new Uint8Array(0), 'wrong-password'), 'invalid-password');
	});

	it('rejects a malformed password separator', () => {
		const wire = makeRequest(0x03, domainAddress('example.com'));
		wire[56] = 0x00;
		expectRejected(wire, 'invalid-separator');
	});

	it('rejects an unsupported command', () => {
		const wire = makeRequest(0x03, domainAddress('example.com'));
		wire[58] = 0x03;
		expectRejected(wire, 'unsupported-command');
	});

	it('rejects unsupported address types', () => {
		const wire = makeRequest(0x03, domainAddress('example.com'));
		wire[59] = 0x02;
		expectRejected(wire, 'unsupported-address-type');
	});

	it('rejects an empty domain', () => {
		const wire = makeRequest(0x03, new Uint8Array([0]));
		expectRejected(wire, 'invalid-address');
	});

	it.each([
		{ label: 'whitespace', hostname: 'example .com' },
		{ label: 'slash', hostname: 'example.com/path' },
		{ label: 'NUL', hostname: 'example\u0000.com' },
		{ label: 'non-ASCII', hostname: 'exämple.com' },
		{ label: 'empty label', hostname: 'example..com' },
		{ label: 'overlong label', hostname: 'a'.repeat(64) + '.com' },
	])('rejects a domain containing $label', ({ hostname }) => {
		const wire = makeRequest(0x03, domainAddress(hostname));
		expectRejected(wire, 'invalid-address');
	});

	it('rejects invalid UTF-8 domain bytes', () => {
		const wire = makeRequest(0x03, new Uint8Array([2, 0xc3, 0x28]));
		expectRejected(wire, 'invalid-address');
	});

	it('rejects port zero', () => {
		expectRejected(makeRequest(0x03, domainAddress('example.com'), 0), 'invalid-port');
	});

	it('rejects a missing request CRLF', () => {
		const wire = makeRequest(0x03, domainAddress('example.com'));
		wire[wire.byteLength - 2] = 0x00;
		expectRejected(wire, 'invalid-separator');
	});

	it.each([
		{ label: 'IPv4', addressType: 0x01, address: new Uint8Array([192, 0, 2]) },
		{ label: 'IPv6', addressType: 0x04, address: new Uint8Array([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0]) },
	])('waits for a truncated $label address', ({ addressType, address }) => {
		const wire = makeRequest(addressType, address);
		expect(parseTrojanRequest(wire, PASSWORD_HASH)).toEqual({ status: 'pending' });
	});
});
