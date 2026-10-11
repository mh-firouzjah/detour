import { createTunnelWorker, type TunnelWorkerEnvironment } from './worker';

const tunnelWorker = createTunnelWorker();

export default {
	fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return tunnelWorker.fetch(request, env as unknown as TunnelWorkerEnvironment);
	},
} satisfies ExportedHandler<Env>;
