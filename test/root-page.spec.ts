import { describe, expect, it } from 'vitest';
import { createTunnelWorker } from '../src/worker';

const worker = createTunnelWorker();
const env = {
	TUNNEL_PATH: '/route-a',
	VLESS_PATH: '/route-b',
	TROJAN_PATH: '/route-c',
};

describe('root page', () => {
	it('serves the diagnostics page', async () => {
		const response = await worker.fetch(new Request('https://example.test/'), env);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Network diagnostics');
	});

	it('supports HEAD without returning a body', async () => {
		const response = await worker.fetch(new Request('https://example.test/', { method: 'HEAD' }), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});
});
