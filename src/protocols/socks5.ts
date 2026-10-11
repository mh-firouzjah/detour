export type Socks5NegotiationRejection =
	'unsupported-version' | 'no-acceptable-method' | 'invalid-authentication-version' | 'invalid-credentials';

export type Socks5NegotiationStep =
	| { status: 'pending'; replies: Uint8Array[] }
	| { status: 'negotiated'; replies: Uint8Array[]; remaining: Uint8Array }
	| { status: 'rejected'; replies: Uint8Array[]; reason: Socks5NegotiationRejection };

type NegotiationState = 'greeting' | 'authentication' | 'completed' | 'rejected';

export class Socks5RequestError extends Error {
	constructor(
		readonly replyCode: number,
		message: string,
	) {
		super(message);
		this.name = 'Socks5RequestError';
	}
}

export class Socks5Negotiator {
	private state: NegotiationState = 'greeting';
	private rejectionReason: Socks5NegotiationRejection = 'unsupported-version';
	private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private readonly expectedUsername: Uint8Array;
	private readonly expectedPassword: Uint8Array;

	constructor(username: string, password: string) {
		const encoder = new TextEncoder();
		this.expectedUsername = encoder.encode(username);
		this.expectedPassword = encoder.encode(password);
	}

	feed(data: Uint8Array): Socks5NegotiationStep {
		if (this.state === 'completed') {
			return { status: 'negotiated', replies: [], remaining: data };
		}

		if (this.state === 'rejected') {
			return { status: 'rejected', replies: [], reason: this.rejectionReason };
		}

		if (this.buffer.length === 0) {
			this.buffer = data;
		} else {
			const combined = new Uint8Array(this.buffer.length + data.length);
			combined.set(this.buffer);
			combined.set(data, this.buffer.length);
			this.buffer = combined;
		}

		const replies: Uint8Array[] = [];

		if (this.state === 'greeting') {
			if (this.buffer.length < 2) {
				return { status: 'pending', replies };
			}

			if (this.buffer[0] !== 0x05) {
				return this.reject(replies, 'unsupported-version');
			}

			const methodCount = this.buffer[1];
			const greetingLength = 2 + methodCount;
			if (this.buffer.length < greetingLength) {
				return { status: 'pending', replies };
			}

			if (!this.buffer.subarray(2, greetingLength).includes(0x02)) {
				return this.reject(replies, 'no-acceptable-method', [0x05, 0xff]);
			}

			this.buffer = this.buffer.subarray(greetingLength);
			this.state = 'authentication';
			replies.push(new Uint8Array([0x05, 0x02]));
		}

		if (this.state === 'authentication') {
			if (this.buffer.length < 2) {
				return { status: 'pending', replies };
			}

			if (this.buffer[0] !== 0x01) {
				return this.reject(replies, 'invalid-authentication-version', [0x01, 0x01]);
			}

			const usernameLength = this.buffer[1];
			if (usernameLength === 0) {
				return this.reject(replies, 'invalid-credentials', [0x01, 0x01]);
			}

			const passwordLengthOffset = 2 + usernameLength;
			if (this.buffer.length <= passwordLengthOffset) {
				return { status: 'pending', replies };
			}

			const passwordLength = this.buffer[passwordLengthOffset];
			if (passwordLength === 0) {
				return this.reject(replies, 'invalid-credentials', [0x01, 0x01]);
			}

			const authLength = passwordLengthOffset + 1 + passwordLength;
			if (this.buffer.length < authLength) {
				return { status: 'pending', replies };
			}

			const receivedUsername = this.buffer.subarray(2, passwordLengthOffset);
			const receivedPassword = this.buffer.subarray(passwordLengthOffset + 1, authLength);
			const validUsername =
				receivedUsername.length === this.expectedUsername.length &&
				receivedUsername.every((byte, index) => byte === this.expectedUsername[index]);
			const validPassword =
				receivedPassword.length === this.expectedPassword.length &&
				receivedPassword.every((byte, index) => byte === this.expectedPassword[index]);

			if (!validUsername || !validPassword) {
				return this.reject(replies, 'invalid-credentials', [0x01, 0x01]);
			}

			const remaining = this.buffer.subarray(authLength);
			this.buffer = new Uint8Array(0);
			this.state = 'completed';
			replies.push(new Uint8Array([0x01, 0x00]));
			return { status: 'negotiated', replies, remaining };
		}

		return { status: 'pending', replies };
	}

	private reject(replies: Uint8Array[], reason: Socks5NegotiationRejection, reply?: number[]): Socks5NegotiationStep {
		this.state = 'rejected';
		this.rejectionReason = reason;
		this.buffer = new Uint8Array(0);

		if (reply) {
			replies.push(new Uint8Array(reply));
		}

		return { status: 'rejected', replies, reason };
	}
}

export function encodeSocks5Reply(reply: number): Uint8Array {
	return new Uint8Array([0x05, reply, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

export type Socks5ConnectRequest = {
	hostname: string;
	port: number;
	remaining: Uint8Array;
};

export function parseSocks5ConnectRequest(data: Uint8Array): Socks5ConnectRequest | null {
	if (data.length < 4) {
		return null;
	}

	if (data[0] !== 0x05) {
		throw new Socks5RequestError(0x01, 'Invalid SOCKS version');
	}

	if (data[1] !== 0x01) {
		throw new Socks5RequestError(0x07, 'Unsupported SOCKS command');
	}

	if (data[2] !== 0x00) {
		throw new Socks5RequestError(0x01, 'Invalid reserved field');
	}

	const addressType = data[3];
	let hostname: string;
	let portOffset: number;

	switch (addressType) {
		case 0x01: {
			if (data.length < 10) {
				return null;
			}

			hostname = Array.from(data.subarray(4, 8)).join('.');
			portOffset = 8;
			break;
		}

		case 0x03: {
			if (data.length < 5) {
				return null;
			}

			const domainLength = data[4];

			if (domainLength === 0) {
				throw new Socks5RequestError(0x01, 'Empty destination hostname');
			}

			portOffset = 5 + domainLength;

			if (data.length < portOffset + 2) {
				return null;
			}

			try {
				hostname = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(5, portOffset));
			} catch {
				throw new Socks5RequestError(0x01, 'Invalid destination hostname encoding');
			}

			break;
		}

		case 0x04: {
			if (data.length < 22) {
				return null;
			}

			const groups: string[] = [];

			for (let i = 4; i < 20; i += 2) {
				groups.push(((data[i] << 8) | data[i + 1]).toString(16));
			}

			hostname = groups.join(':');
			portOffset = 20;
			break;
		}

		default:
			throw new Socks5RequestError(0x08, 'Unsupported address type');
	}

	const port = (data[portOffset] << 8) | data[portOffset + 1];

	if (port === 0) {
		throw new Socks5RequestError(0x01, 'Invalid destination port');
	}

	return {
		hostname,
		port,
		remaining: data.subarray(portOffset + 2),
	};
}
