import { connect } from 'cloudflare:sockets';

export interface TcpSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	opened: Promise<unknown>;
	closed: Promise<void>;
	close(): Promise<void>;
}

export type TcpDialer = (hostname: string, port: number) => TcpSocket | Promise<TcpSocket>;

export function dialTcp(hostname: string, port: number): TcpSocket {
	return connect({ hostname, port }, { allowHalfOpen: true });
}
