import { describe, expect, it } from 'vitest';
import { parseVlessRequest, parseVlessUuid } from '../../src/protocols/vless';

const sampleUuid = '00112233-4455-4677-8899-aabbccddeeff';
const sampleUuidBytes = parseVlessUuid(sampleUuid);

if (!sampleUuidBytes) {
	throw new Error('Invalid fixed UUID fixture');
}

function concatenate(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function makeRequest(
	addressType: number,
	address: Uint8Array,
	options: {
		version?: number;
		uuid?: Uint8Array;
		addonsLength?: number;
		command?: number;
		port?: number;
		payload?: Uint8Array;
	} = {},
): Uint8Array {
	const port = options.port ?? 80;

	return concatenate(
		new Uint8Array([
			options.version ?? 0,
			...(options.uuid ?? sampleUuidBytes),
			options.addonsLength ?? 0,
			options.command ?? 1,
			(port >> 8) & 0xff,
			port & 0xff,
			addressType,
		]),
		address,
		options.payload ?? new Uint8Array(0),
	);
}

function makeDomainRequest(domain: Uint8Array, options: Parameters<typeof makeRequest>[2] = {}): Uint8Array {
	if (domain.byteLength > 255) {
		throw new RangeError('VLESS domain name is too long');
	}

	return makeRequest(0x02, concatenate(new Uint8Array([domain.byteLength]), domain), options);
}

describe('VLESS parser boundary cases', () => {
	it('returns pending for every truncated prefix of a valid domain header', () => {
		const request = makeDomainRequest(new TextEncoder().encode('example.com'));

		for (let length = 0; length < request.byteLength; length += 1) {
			expect(parseVlessRequest(request.subarray(0, length), sampleUuidBytes)).toEqual({ status: 'pending' });
		}
	});

	it('parses IPv4 and preserves binary payload bytes', () => {
		const payload = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x0d, 0x0a]);
		const request = makeRequest(0x01, new Uint8Array([192, 0, 2, 10]), { payload });
		const parsed = parseVlessRequest(request, sampleUuidBytes);

		expect(parsed.status).toBe('complete');
		if (parsed.status === 'complete') {
			expect(parsed.request.hostname).toBe('192.0.2.10');
			expect(parsed.request.port).toBe(80);
			expect(Array.from(parsed.request.remaining)).toEqual(Array.from(payload));
		}
	});

	it('parses IPv6 addresses', () => {
		const address = new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
		const parsed = parseVlessRequest(makeRequest(0x03, address), sampleUuidBytes);

		expect(parsed).toMatchObject({
			status: 'complete',
			request: { hostname: '2001:db8:0:0:0:0:0:1', port: 80 },
		});
	});

	it('accepts the maximum 255-byte domain header', () => {
		const domain = new TextEncoder().encode('a'.repeat(255));
		const request = makeDomainRequest(domain);
		const parsed = parseVlessRequest(request, sampleUuidBytes);

		expect(request.byteLength).toBe(278);
		expect(parsed.status).toBe('complete');
		if (parsed.status === 'complete') {
			expect(parsed.request.hostname).toBe('a'.repeat(255));
		}
	});

	it('returns pending for truncated IPv4 and IPv6 addresses', () => {
		const ipv4 = makeRequest(0x01, new Uint8Array([192, 0, 2]));
		const ipv6 = makeRequest(0x03, new Uint8Array(15));

		expect(parseVlessRequest(ipv4, sampleUuidBytes)).toEqual({ status: 'pending' });
		expect(parseVlessRequest(ipv6, sampleUuidBytes)).toEqual({ status: 'pending' });
	});

	it.each([
		{ name: 'empty domain', value: new Uint8Array(0) },
		{ name: 'domain containing NUL', value: new Uint8Array([0x61, 0x00, 0x62]) },
		{ name: 'domain containing whitespace', value: new TextEncoder().encode('bad host') },
		{ name: 'domain containing slash', value: new TextEncoder().encode('bad/host') },
		{ name: 'domain containing non-ASCII UTF-8', value: new TextEncoder().encode('münich.example') },
		{ name: 'domain containing invalid UTF-8', value: new Uint8Array([0xff, 0xfe]) },
	])('rejects $name', ({ value }) => {
		expect(parseVlessRequest(makeDomainRequest(value), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'invalid-address',
		});
	});

	it('rejects port zero', () => {
		const request = makeDomainRequest(new TextEncoder().encode('example.com'), { port: 0 });

		expect(parseVlessRequest(request, sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'invalid-port',
		});
	});

	it('rejects unsupported commands and address types', () => {
		const domain = new TextEncoder().encode('example.com');

		expect(parseVlessRequest(makeDomainRequest(domain, { command: 2 }), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'unsupported-command',
		});
		expect(parseVlessRequest(makeRequest(0x04, new Uint8Array(0)), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'unsupported-address-type',
		});
	});

	it('rejects invalid version, UUID, and non-empty addons', () => {
		const domain = new TextEncoder().encode('example.com');
		const wrongUuid = sampleUuidBytes.slice();
		wrongUuid[0] ^= 0xff;

		expect(parseVlessRequest(makeDomainRequest(domain, { version: 1 }), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'invalid-version',
		});
		expect(parseVlessRequest(makeDomainRequest(domain, { uuid: wrongUuid }), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'invalid-uuid',
		});
		expect(parseVlessRequest(makeDomainRequest(domain, { addonsLength: 1 }), sampleUuidBytes)).toMatchObject({
			status: 'rejected',
			reason: 'unsupported-addons',
		});
	});
});
