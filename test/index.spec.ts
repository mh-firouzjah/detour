import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function configuredTunnelPath(): string {
	const path = (env as unknown as { TUNNEL_PATH?: string }).TUNNEL_PATH;
	if (!path) {
		throw new Error('TUNNEL_PATH must be configured in .dev.vars for these tests');
	}
	return path;
}

describe('Default Worker', () => {
	it('does not accept a tunnel until a session handler is configured', async () => {
		const request = new IncomingRequest(`https://example.com${configuredTunnelPath()}`, {
			headers: { Upgrade: 'websocket' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
	});

	it('returns 404 for paths outside the configured tunnel route', async () => {
		const response = await SELF.fetch(`https://example.com${configuredTunnelPath()}__not_found__`);
		expect(response.status).toBe(404);
	});
});
