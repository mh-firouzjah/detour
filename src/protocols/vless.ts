export type VlessRejectionReason =
	| 'invalid-version'
	| 'invalid-uuid'
	| 'unsupported-addons'
	| 'unsupported-command'
	| 'unsupported-address-type'
	| 'invalid-address'
	| 'invalid-port';

export interface VlessRequest {
	version: number;
	hostname: string;
	port: number;
	remaining: Uint8Array<ArrayBufferLike>;
}

export type VlessRequestParseResult =
	{ status: 'pending' } | { status: 'rejected'; reason: VlessRejectionReason } | { status: 'complete'; request: VlessRequest };

export function parseVlessUuid(value: string): Uint8Array | undefined {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
		return undefined;
	}

	const hex = value.replaceAll('-', '');
	const bytes = new Uint8Array(16);

	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}

	return bytes;
}

export function isValidVlessUuid(value: string | undefined): value is string {
	return value !== undefined && parseVlessUuid(value) !== undefined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}

	let difference = 0;

	for (let i = 0; i < left.byteLength; i += 1) {
		difference |= left[i] ^ right[i];
	}

	return difference === 0;
}

export function parseVlessRequest(data: Uint8Array, expectedUuid: Uint8Array): VlessRequestParseResult {
	if (data.byteLength === 0) {
		return { status: 'pending' };
	}

	// Xray-core currently uses VLESS wire version zero.
	if (data[0] !== 0) {
		return { status: 'rejected', reason: 'invalid-version' };
	}

	if (data.byteLength < 17) {
		return { status: 'pending' };
	}

	if (!equalBytes(data.subarray(1, 17), expectedUuid)) {
		return { status: 'rejected', reason: 'invalid-uuid' };
	}

	if (data.byteLength < 18) {
		return { status: 'pending' };
	}

	const addonsLength = data[17];

	// This implementation supports no VLESS addons/flow.
	if (addonsLength !== 0) {
		return { status: 'rejected', reason: 'unsupported-addons' };
	}

	const commandOffset = 18;

	// Command, two-byte port, and address type.
	if (data.byteLength < commandOffset + 4) {
		return { status: 'pending' };
	}

	if (data[commandOffset] !== 0x01) {
		return { status: 'rejected', reason: 'unsupported-command' };
	}

	const port = (data[commandOffset + 1] << 8) | data[commandOffset + 2];

	if (port === 0) {
		return { status: 'rejected', reason: 'invalid-port' };
	}

	const addressType = data[commandOffset + 3];
	const addressOffset = commandOffset + 4;
	let hostname: string;
	let endOffset: number;

	switch (addressType) {
		case 0x01: {
			endOffset = addressOffset + 4;

			if (data.byteLength < endOffset) {
				return { status: 'pending' };
			}

			hostname = Array.from(data.subarray(addressOffset, endOffset)).join('.');
			break;
		}

		case 0x02: {
			if (data.byteLength < addressOffset + 1) {
				return { status: 'pending' };
			}

			const domainLength = data[addressOffset];

			if (domainLength === 0) {
				return { status: 'rejected', reason: 'invalid-address' };
			}

			endOffset = addressOffset + 1 + domainLength;

			if (data.byteLength < endOffset) {
				return { status: 'pending' };
			}

			try {
				hostname = new TextDecoder('utf-8', {
					fatal: true,
					ignoreBOM: true,
				}).decode(data.subarray(addressOffset + 1, endOffset));
			} catch {
				return { status: 'rejected', reason: 'invalid-address' };
			}

			if (!/^[0-9a-z._-]+$/i.test(hostname)) {
				return { status: 'rejected', reason: 'invalid-address' };
			}

			break;
		}

		case 0x03: {
			endOffset = addressOffset + 16;

			if (data.byteLength < endOffset) {
				return { status: 'pending' };
			}

			const groups: string[] = [];

			for (let i = addressOffset; i < endOffset; i += 2) {
				groups.push(((data[i] << 8) | data[i + 1]).toString(16));
			}

			hostname = groups.join(':');
			break;
		}

		default:
			return { status: 'rejected', reason: 'unsupported-address-type' };
	}

	return {
		status: 'complete',
		request: {
			version: data[0],
			hostname,
			port,
			remaining: data.subarray(endOffset),
		},
	};
}
