import { createHash } from 'node:crypto';

export type TrojanRejectionReason =
	'invalid-password' | 'invalid-separator' | 'unsupported-command' | 'unsupported-address-type' | 'invalid-address' | 'invalid-port';

export interface TrojanRequest {
	hostname: string;
	port: number;
	remaining: Uint8Array<ArrayBufferLike>;
}

export type TrojanRequestParseResult =
	{ status: 'pending' } | { status: 'rejected'; reason: TrojanRejectionReason } | { status: 'complete'; request: TrojanRequest };

export const MAX_TROJAN_HEADER_BYTES = 56 + 2 + 1 + 1 + 1 + 255 + 2 + 2;

const PASSWORD_HASH_HEX_BYTES = 56;
const PASSWORD_SEPARATOR_BYTES = 2;
const REQUEST_OFFSET = PASSWORD_HASH_HEX_BYTES + PASSWORD_SEPARATOR_BYTES;
const ADDRESS_OFFSET = REQUEST_OFFSET + 2;
const CR = 0x0d;
const LF = 0x0a;

// SHA224(password) encoded as 56 lowercase ASCII hex characters.
export function hashTrojanPassword(password: string): string {
	return createHash('sha224').update(password, 'utf8').digest('hex');
}

function matchesPasswordHash(data: Uint8Array, expectedHash: string): boolean {
	if (expectedHash.length !== PASSWORD_HASH_HEX_BYTES) {
		return false;
	}

	let difference = 0;

	for (let index = 0; index < PASSWORD_HASH_HEX_BYTES; index += 1) {
		difference |= data[index] ^ expectedHash.charCodeAt(index);
	}

	return difference === 0;
}

function decodeDomain(data: Uint8Array): string | undefined {
	if (data.byteLength === 0 || data.some((byte) => byte > 0x7f)) {
		return undefined;
	}

	const hostname = String.fromCharCode(...data);

	if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || hostname.startsWith('.') || hostname.includes('..')) {
		return undefined;
	}

	const withoutTrailingDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

	if (withoutTrailingDot.length === 0) {
		return undefined;
	}

	const labels = withoutTrailingDot.split('.');

	if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
		return undefined;
	}

	return hostname;
}

export function parseTrojanRequest(data: Uint8Array, expectedPasswordHash: string): TrojanRequestParseResult {
	if (data.byteLength < PASSWORD_HASH_HEX_BYTES) {
		return { status: 'pending' };
	}

	if (!matchesPasswordHash(data, expectedPasswordHash)) {
		return { status: 'rejected', reason: 'invalid-password' };
	}

	if (data.byteLength < REQUEST_OFFSET) {
		return { status: 'pending' };
	}

	if (data[PASSWORD_HASH_HEX_BYTES] !== CR || data[PASSWORD_HASH_HEX_BYTES + 1] !== LF) {
		return { status: 'rejected', reason: 'invalid-separator' };
	}

	if (data.byteLength < ADDRESS_OFFSET) {
		return { status: 'pending' };
	}

	const command = data[REQUEST_OFFSET];
	if (command !== 0x01) {
		return { status: 'rejected', reason: 'unsupported-command' };
	}

	const addressType = data[REQUEST_OFFSET + 1];
	let hostname: string;
	let addressEnd: number;

	switch (addressType) {
		case 0x01: {
			addressEnd = ADDRESS_OFFSET + 4;

			if (data.byteLength < addressEnd) {
				return { status: 'pending' };
			}

			hostname = Array.from(data.subarray(ADDRESS_OFFSET, addressEnd)).join('.');
			break;
		}

		case 0x03: {
			if (data.byteLength < ADDRESS_OFFSET + 1) {
				return { status: 'pending' };
			}

			const domainLength = data[ADDRESS_OFFSET];
			if (domainLength === 0) {
				return { status: 'rejected', reason: 'invalid-address' };
			}

			addressEnd = ADDRESS_OFFSET + 1 + domainLength;
			if (data.byteLength < addressEnd) {
				return { status: 'pending' };
			}

			const decoded = decodeDomain(data.subarray(ADDRESS_OFFSET + 1, addressEnd));
			if (decoded === undefined) {
				return { status: 'rejected', reason: 'invalid-address' };
			}

			hostname = decoded;
			break;
		}

		case 0x04: {
			addressEnd = ADDRESS_OFFSET + 16;
			if (data.byteLength < addressEnd) {
				return { status: 'pending' };
			}

			const groups: string[] = [];
			for (let index = ADDRESS_OFFSET; index < addressEnd; index += 2) {
				groups.push(((data[index] << 8) | data[index + 1]).toString(16));
			}

			hostname = groups.join(':');
			break;
		}

		default:
			return { status: 'rejected', reason: 'unsupported-address-type' };
	}

	// Port (two bytes) and the CRLF after the Trojan request must be present.
	if (data.byteLength < addressEnd + 4) {
		return { status: 'pending' };
	}

	const port = (data[addressEnd] << 8) | data[addressEnd + 1];
	if (port === 0) {
		return { status: 'rejected', reason: 'invalid-port' };
	}

	if (data[addressEnd + 2] !== CR || data[addressEnd + 3] !== LF) {
		return { status: 'rejected', reason: 'invalid-separator' };
	}

	return {
		status: 'complete',
		request: {
			hostname,
			port,
			remaining: data.subarray(addressEnd + 4),
		},
	};
}
