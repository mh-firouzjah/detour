#!/usr/bin/env node
/**
 * Live integration matrix for a deployed detour Worker.
 *
 * This is intentionally separate from `npm test`: it needs network access plus
 * locally installed curl, sing-box, and (optionally) GOST. Temporary configs and
 * client logs live in one private temporary directory and are deleted by default.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SMALL_URL = process.env.DETOUR_TEST_SMALL_URL ?? 'https://bom.proof.ovh.net/files/1Mb.dat';
const LARGE_URL = process.env.DETOUR_TEST_LARGE_URL ?? 'https://bom.proof.ovh.net/files/10Mb.dat';
const SMALL_BYTES = 1_048_576;
const LARGE_BYTES = 10_485_760;
const MAX_REDIRECTS = 5;
const requestedIpLimit = Number.parseInt(process.env.DETOUR_TEST_MAX_IPS ?? '3', 10);
const REQUIRED_IP_LIMIT = Number.isInteger(requestedIpLimit) ? Math.max(1, Math.min(8, requestedIpLimit)) : 3;
const KEEP_ARTIFACTS = process.env.DETOUR_KEEP_TEST_ARTIFACTS === '1';

// Accept readable local .dev.vars names and the short names used by the deployed Worker.
// The value is never printed. Keep this alias table aligned with src/index.ts.
const bindingAliases = {
	tunnelPath: ['TUNNEL_PATH', 'A0'],
	socksUsername: ['SOCKS5_USERNAME', 'B1'],
	socksPassword: ['SOCKS5_PASSWORD', 'B2'],
	vlessPath: ['VLESS_PATH', 'C1'],
	vlessUuid: ['VLESS_UUID', 'C2'],
	trojanPath: ['TROJAN_PATH', 'D1'],
	trojanPassword: ['TROJAN_PASSWORD', 'D2'],
	tcpConnectTimeoutMs: ['TCP_CONNECT_TIMEOUT_MS', 'E1'],
};
const requiredFields = ['tunnelPath', 'socksUsername', 'socksPassword', 'vlessPath', 'vlessUuid', 'trojanPath', 'trojanPassword'];
const url = process.env.DETOUR_TEST_URL ?? 'https://detour.mh-firouzjah.workers.dev';
let tempDir;
const children = new Set();
let requiredPass = 0;
let requiredFail = 0;
let controlPass = 0;
let controlFail = 0;
let cloudflareEgressDiagnosed = false;

function fail(message) {
	console.error(`ERROR: ${message}`);
	process.exitCode = 2;
	throw new Error(message);
}

function ensureLocalGitExclude() {
	const result = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	if (result.status !== 0) return;
	const excludePath = path.isAbsolute(result.stdout.trim()) ? result.stdout.trim() : path.resolve(repoRoot, result.stdout.trim());
	const patterns = ['/.detour-live-test-*/'];
	fs.mkdirSync(path.dirname(excludePath), { recursive: true });
	let current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
	let changed = false;
	for (const pattern of patterns) {
		if (!current.split(/\r?\n/).includes(pattern)) {
			current += `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${pattern}\n`;
			changed = true;
		}
	}
	if (changed) fs.writeFileSync(excludePath, current, { mode: 0o600 });
}

function parseEnvFile(file) {
	const parsed = {};
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match || match[1].startsWith('#')) continue;
		const [, key] = match;
		let value = match[2];
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1);
			}
		} else if (value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, '').trim();
		}
		parsed[key] = value;
	}
	return parsed;
}

function readPrivateConfig() {
	const file = path.join(repoRoot, '.dev.vars');
	if (!fs.existsSync(file)) fail('`.dev.vars` not found; configure local secrets before running live tests.');
	const raw = parseEnvFile(file);
	const config = {};
	for (const [meaning, aliases] of Object.entries(bindingAliases)) {
		const value = aliases.map((name) => raw[name]).find((candidate) => candidate !== undefined);
		if (value !== undefined) config[meaning] = value;
	}
	const missing = requiredFields.filter((key) => !config[key]);
	if (missing.length) {
		fail(`Missing required local Worker settings: ${missing.map((key) => bindingAliases[key][0]).join(', ')}`);
	}
	const paths = [config.tunnelPath, config.vlessPath, config.trojanPath];
	if (paths.some((p) => !p.startsWith('/') || p.startsWith('//') || /[?#]/.test(p)) || new Set(paths).size !== paths.length) {
		fail('Local Worker paths are invalid or duplicated.');
	}
	return config;
}

function redact(value, sensitive) {
	let result = String(value ?? '');
	for (const secret of [...sensitive].filter((item) => typeof item === 'string' && item.length).sort((a, b) => b.length - a.length)) {
		result = result.split(secret).join('[REDACTED]');
	}
	return result;
}

function commandExists(command) {
	return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function runCapture(command, args, timeoutMs = 15000) {
	return spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function canConnect(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		socket.setTimeout(250);
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
		socket.once('timeout', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function waitForListener(port, child, logFile, sensitive) {
	const end = Date.now() + 10000;
	while (Date.now() < end) {
		if (child.exitCode !== null || child.signalCode !== null) {
			const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-1800) : '';
			throw new Error(`Client exited before opening its local listener. ${redact(tail, sensitive)}`);
		}
		if (await canConnect(port)) return;
		await sleep(120);
	}
	throw new Error('Timed out waiting for the client local SOCKS listener.');
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGTERM');
	await Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(1200)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL');
		await Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(500)]);
	}
	children.delete(child);
}

function parseCurlMetrics(stdout) {
	const metrics = {};
	for (const part of stdout.trim().split(/\s+/)) {
		const index = part.indexOf('=');
		if (index > 0) metrics[part.slice(0, index)] = part.slice(index + 1);
	}
	if (!/^\d{3}$/.test(metrics.HTTP ?? '') || !Number.isFinite(Number(metrics.bytes)) || !Number.isFinite(Number(metrics.total)))
		return null;
	return {
		status: Number(metrics.HTTP),
		bytes: Number(metrics.bytes),
		total: Number(metrics.total),
		redirects: Number(metrics.redirects ?? 0),
		effectiveUrl: metrics.effective ?? '',
	};
}

function targetUrl(source) {
	// Use the canonical vendor test URL: its HTTPS redirect is followed below.
	// Do not append a query string to a static test file URL.
	return new URL(source).toString();
}

async function curlThroughSocks(port, target, options = {}, sensitive = []) {
	const {
		large = false,
		timeoutMs = large ? 50000 : 18000,
		expectedStatus = 200,
		minBytes = large ? LARGE_BYTES : SMALL_BYTES,
		minDuration = large ? 10 : 0,
	} = options;
	const headers = path.join(tempDir, `curl-${Date.now()}-${Math.random().toString(16).slice(2)}.headers`);
	const headerFd = fs.openSync(headers, 'w', 0o600);
	fs.closeSync(headerFd);
	const args = [
		'--location',
		'--max-redirs',
		String(MAX_REDIRECTS),
		'--proto-redir',
		'=https',
		'--silent',
		'--show-error',
		'--noproxy',
		'',
		'--proxy',
		`socks5h://127.0.0.1:${port}`,
		'--connect-timeout',
		'6',
		'--max-time',
		String(timeoutMs / 1000),
		'--dump-header',
		headers,
		'--output',
		os.devNull,
		'--header',
		'Cache-Control: no-cache',
		'--write-out',
		'HTTP=%{http_code} bytes=%{size_download} total=%{time_total} redirects=%{num_redirects} effective=%{url_effective}',
	];
	if (large) args.push('--limit-rate', '512k');
	args.push(target);
	let result;
	try {
		result = await new Promise((resolve, reject) => {
			const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
			child.once('error', reject);
			child.once('close', (code) => resolve({ code, stdout, stderr }));
		});
	} catch (error) {
		return { ok: false, summary: 'curl failed to start', detail: redact(error.message, sensitive) };
	}
	const metrics = parseCurlMetrics(result.stdout);
	const ok =
		result.code === 0 && metrics !== null && metrics.status === expectedStatus && metrics.bytes >= minBytes && metrics.total >= minDuration;
	let detail = redact(result.stderr.trim(), sensitive);
	if (!ok && fs.existsSync(headers)) {
		const responseHeaders = fs
			.readFileSync(headers, 'utf8')
			.split(/\r?\n/)
			.filter((line) => /^HTTP\/|^location:/i.test(line))
			.slice(-12)
			.join('\n');
		if (responseHeaders) detail = `${detail}${detail ? '\n' : ''}${redact(responseHeaders, sensitive)}`;
	}
	if (!metrics) return { ok: false, summary: `HTTP=000 (curl exit ${result.code})`, detail: detail || 'No HTTP response was received.' };
	return {
		ok,
		summary: `HTTP=${metrics.status} bytes=${Math.round(metrics.bytes)} duration=${metrics.total.toFixed(2)}s redirects=${metrics.redirects}`,
		detail,
	};
}

async function waitForRoot(host, ip) {
	const started = Date.now();
	const result = runCapture(
		'curl',
		[
			'--silent',
			'--show-error',
			'--noproxy',
			'*',
			'--resolve',
			`${host}:443:${ip}`,
			'--connect-timeout',
			'4',
			'--max-time',
			'6',
			'--output',
			os.devNull,
			'--write-out',
			'HTTP=%{http_code} ttfb=%{time_starttransfer} remote=%{remote_ip}',
			`https://${host}/`,
		],
		8000,
	);
	const fields = Object.fromEntries(
		(result.stdout ?? '')
			.trim()
			.split(/\s+/)
			.map((part) => part.split('='))
			.filter((pair) => pair.length === 2),
	);
	return {
		ip,
		status: Number(fields.HTTP ?? 0),
		ttfb: Number(fields.ttfb ?? 0),
		elapsedMs: Date.now() - started,
		detail: (result.stderr ?? '').trim().split(/\r?\n/).at(-1) ?? '',
	};
}

function candidateIps(host) {
	const candidates = [];
	const add = (value) => {
		if (net.isIP(value) === 4 && !candidates.includes(value)) candidates.push(value);
	};
	for (const ip of (process.env.DETOUR_TEST_IPS ?? '').split(/[\s,;]+/)) add(ip.trim());
	const ipFile = process.env.DETOUR_TEST_IP_FILE;
	if (ipFile && fs.existsSync(ipFile)) {
		// Accept CloudflareSpeedTest-style CSV: the IP address is the first column.
		for (const line of fs.readFileSync(ipFile, 'utf8').split(/\r?\n/)) {
			const field = line.split(',')[0]?.trim();
			add(field);
		}
	}
	return dns
		.resolve4(host)
		.then((ips) => {
			for (const ip of ips) add(ip);
			// Historical observations only; preflight must prove each IP is usable.
			add('104.21.96.90');
			add('172.67.176.68');
			return candidates.slice(0, 64);
		})
		.catch(() => {
			add('104.21.96.90');
			add('172.67.176.68');
			return candidates.slice(0, 64);
		});
}

function singBoxConfig({ host, ip, port, protocol, path: wsPath, credential, ech }) {
	const outbound = {
		type: protocol,
		tag: 'upstream',
		server: ip,
		server_port: 443,
		tls: {
			enabled: true,
			server_name: host,
			ech: { enabled: ech, query_server_name: host },
		},
		transport: { type: 'ws', path: wsPath, headers: { Host: host } },
	};
	if (protocol === 'vless') outbound.uuid = credential;
	else outbound.password = credential;
	return {
		dns: {
			servers: [{ type: 'local', tag: 'system', prefer_go: true }],
			final: 'system',
			strategy: 'ipv4_only',
		},
		log: { level: 'info' },
		inbounds: [{ type: 'socks', tag: 'local-in', listen: '127.0.0.1', listen_port: port }],
		outbounds: [outbound],
		route: { final: 'upstream' },
	};
}

function gostConfig({ host, ip, port, config }) {
	return {
		services: [
			{
				name: 'local-socks',
				addr: `127.0.0.1:${port}`,
				handler: {
					type: 'socks5',
					chain: 'chain-0',
					metadata: { notls: true },
				},
				listener: { type: 'tcp' },
			},
		],
		chains: [
			{
				name: 'chain-0',
				hops: [
					{
						name: 'hop-0',
						nodes: [
							{
								name: 'worker',
								addr: `${ip}:443`,
								connector: { type: 'socks5', auth: { username: config.socksUsername, password: config.socksPassword } },
								dialer: { type: 'wss', metadata: { path: config.tunnelPath, host }, tls: { secure: true, serverName: host } },
							},
						],
					},
				],
			},
		],
	};
}

async function runClientCase({ label, host, ip, protocol, ech, wsPath, credential, config, required }) {
	const port = await findFreePort();
	const logFile = path.join(tempDir, `${label.replace(/[^a-z0-9-]/gi, '-')}.log`);
	const configFile = path.join(tempDir, `${label.replace(/[^a-z0-9-]/gi, '-')}.json`);
	const sensitive = Object.values(config).filter((value) => typeof value === 'string');
	const clientConfig =
		protocol === 'gost'
			? gostConfig({ host, ip, port, config })
			: singBoxConfig({ host, ip, port, protocol, path: wsPath, credential, ech });
	fs.writeFileSync(configFile, `${JSON.stringify(clientConfig)}\n`, { mode: 0o600 });
	fs.chmodSync(configFile, 0o600);
	const check = protocol === 'gost' ? { status: 0, stdout: '', stderr: '' } : runCapture('sing-box', ['check', '-c', configFile], 12000);
	if (check.status !== 0) {
		const result = {
			label,
			required,
			ok: false,
			summary: 'client configuration rejected',
			detail: redact(`${check.stdout}\n${check.stderr}`, sensitive),
		};
		record(result);
		fs.rmSync(configFile, { force: true });
		return;
	}
	const args = protocol === 'gost' ? ['-C', configFile] : ['run', '-c', configFile];
	const child = spawn(protocol === 'gost' ? 'gost' : 'sing-box', args, { stdio: ['ignore', 'pipe', 'pipe'] });
	children.add(child);
	let clientOutput = '';
	const capture = (chunk) => {
		clientOutput = (clientOutput + chunk.toString()).slice(-10000);
	};
	const appendLog = (chunk) => {
		capture(chunk);
		try {
			fs.appendFileSync(logFile, chunk, { mode: 0o600 });
		} catch {}
	};
	child.stdout.on('data', appendLog);
	child.stderr.on('data', appendLog);
	try {
		await waitForListener(port, child, logFile, sensitive);
		// Keep the complete client log within the private run directory while the
		// process is alive. The directory is removed automatically unless opted in.
		if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', { mode: 0o600 });
		const smoke = await curlThroughSocks(
			port,
			targetUrl(SMALL_URL),
			{
				timeoutMs: required ? 12000 : 8000,
			},
			sensitive,
		);
		record({ label: `${label} / HTTP smoke`, required, ...smoke });
		if (!smoke.ok && clientOutput) printClientTail(clientOutput, sensitive);

		if (smoke.ok) {
			if (required) {
				const transfer = await curlThroughSocks(
					port,
					targetUrl(LARGE_URL),
					{
						large: true,
						timeoutMs: 50000,
					},
					sensitive,
				);
				record({ label: `${label} / 10 MB sustained download`, required: true, ...transfer });
				if (!transfer.ok && clientOutput) printClientTail(clientOutput, sensitive);
				for (let attempt = 1; attempt <= 3; attempt++) {
					const reconnect = await curlThroughSocks(
						port,
						targetUrl(SMALL_URL),
						{
							timeoutMs: 12000,
						},
						sensitive,
					);
					record({ label: `${label} / reconnect ${attempt}`, required: true, ...reconnect });
					if (!reconnect.ok && clientOutput) printClientTail(clientOutput, sensitive);
				}
			}

			// Exercise an HTTPS destination fronted by Cloudflare. Failure here is
			// reported as a diagnostic platform-egress limitation, not as failure
			// of the client-to-Worker protocol path.
			if (protocol === 'vless' && ech && !cloudflareEgressDiagnosed) {
				cloudflareEgressDiagnosed = true;
				const egress = await curlThroughSocks(
					port,
					'https://www.cloudflare.com/cdn-cgi/trace',
					{
						timeoutMs: 10000,
						expectedStatus: 200,
						minBytes: 1,
					},
					sensitive,
				);
				record({
					label: 'Cloudflare-hosted destination (egress diagnostic)',
					required: false,
					...egress,
					detail: egress.ok
						? egress.detail
						: `${egress.detail ? `${egress.detail}\n` : ''}A failure may be the documented Worker TCP-socket restriction for Cloudflare IP ranges; this is separate from ingress ECH.`,
				});
			}
		} else if (required) {
			console.log(`  SKIP: large transfer and reconnect loop for ${label}; smoke test did not pass.`);
			// A single retry distinguishes an intermittent route from a stable failure
			// without multiplying several long timeouts for an already-dead path.
			const retry = await curlThroughSocks(
				port,
				targetUrl(SMALL_URL),
				{
					timeoutMs: 8000,
				},
				sensitive,
			);
			record({ label: `${label} / smoke retry`, required: true, ...retry });
		}
	} catch (error) {
		const detail = redact(error.message, sensitive);
		record({ label, required, ok: false, summary: 'client/listener failure', detail });
		if (clientOutput) console.log(`  client diagnostics: ${redact(clientOutput.split(/\r?\n/).slice(-8).join('\n'), sensitive)}`);
	} finally {
		await stopChild(child);
		fs.rmSync(configFile, { force: true });
	}
}

function printClientTail(output, sensitive) {
	const tail = output.split(/\r?\n/).filter(Boolean).slice(-10).join('\n');
	if (tail)
		console.log(
			`  client log tail (redacted):\n${redact(tail, sensitive)
				.split('\n')
				.map((line) => `    ${line}`)
				.join('\n')}`,
		);
}

function record(result) {
	const { label, required, ok, summary, detail } = result;
	const tag = ok ? 'PASS' : required ? 'FAIL' : 'CONTROL';
	console.log(`${tag} ${label}: ${summary ?? 'no result'}`);
	if (!ok && detail) console.log(`  ${String(detail).slice(-700).replace(/\n/g, '\n  ')}`);
	if (required) {
		if (ok) requiredPass++;
		else requiredFail++;
	} else {
		if (ok) controlPass++;
		else controlFail++;
	}
}

async function main() {
	let parsedUrl;
	try {
		parsedUrl = new URL(url);
	} catch {
		fail('DETOUR_TEST_URL is not a valid URL.');
	}
	if (parsedUrl.protocol !== 'https:' || parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
		fail('DETOUR_TEST_URL must be the Worker origin, for example https://worker.example.workers.dev.');
	}
	const host = parsedUrl.hostname;
	const config = readPrivateConfig();
	for (const command of ['curl', 'sing-box']) if (!commandExists(command)) fail(`Required command not found: ${command}`);
	const haveGost = commandExists('gost');
	const sensitive = Object.values(config).filter((value) => typeof value === 'string');

	ensureLocalGitExclude();
	tempDir = fs.mkdtempSync(path.join(repoRoot, '.detour-live-test-'));
	fs.chmodSync(tempDir, 0o700);
	console.log('Live integration suite; no source edits or deployment will be performed.');
	console.log(`Worker: ${host}`);
	console.log('Temporary configs, response headers and client logs share one private directory under the repository root.');
	console.log(`Temporary directory: ${path.basename(tempDir)} (removed at end unless DETOUR_KEEP_TEST_ARTIFACTS=1)`);
	console.log('Secret values and protocol paths will not be printed.');

	const candidates = await candidateIps(host);
	if (!candidates.length) fail('No IPv4 candidates found. Set DETOUR_TEST_IPS or DETOUR_TEST_IP_FILE.');
	console.log(`\n=== Ingress candidate check (${candidates.length} addresses) ===`);
	const checked = [];
	for (const ip of candidates.slice(0, Math.min(8, Math.max(REQUIRED_IP_LIMIT * 2, 4)))) {
		const check = await waitForRoot(host, ip);
		checked.push(check);
		const ok = check.status === 200;
		console.log(`${ok ? 'PASS' : 'NO-HTTP'} ${ip}: HTTP=${check.status} ttfb=${check.ttfb.toFixed(3)}s elapsed=${check.elapsedMs}ms`);
	}
	const reachable = checked
		.filter((item) => item.status === 200)
		.sort((a, b) => a.ttfb - b.ttfb)
		.slice(0, REQUIRED_IP_LIMIT);
	if (!reachable.length) fail('No candidate IP returned HTTP 200 for the root path.');

	console.log('\n=== Protocol path checks ===');
	for (const { ip } of reachable) {
		for (const [label, wsPath] of [
			['SOCKS5', config.tunnelPath],
			['VLESS', config.vlessPath],
			['Trojan', config.trojanPath],
		]) {
			const result = runCapture(
				'curl',
				[
					'--silent',
					'--show-error',
					'--noproxy',
					'*',
					'--resolve',
					`${host}:443:${ip}`,
					'--connect-timeout',
					'4',
					'--max-time',
					'6',
					'--output',
					os.devNull,
					'--write-out',
					'%{http_code}',
					`https://${host}${wsPath}`,
				],
				8000,
			);
			const status = Number((result.stdout ?? '').trim());
			const ok = status === 426;
			console.log(`${ok ? 'PASS' : 'FAIL'} ${ip} ${label}: HTTP ${status || 0} (expected 426 without WebSocket upgrade)`);
			record({
				label: `${ip} ${label} path preflight`,
				required: true,
				ok,
				summary: `HTTP ${status || 0}; expected 426 without WebSocket upgrade`,
			});
		}
	}

	console.log('\n=== Required: sing-box with ECH ===');
	for (const { ip } of reachable) {
		await runClientCase({
			label: `VLESS ECH @ ${ip}`,
			host,
			ip,
			protocol: 'vless',
			ech: true,
			wsPath: config.vlessPath,
			credential: config.vlessUuid,
			config,
			required: true,
		});
		await runClientCase({
			label: `Trojan ECH @ ${ip}`,
			host,
			ip,
			protocol: 'trojan',
			ech: true,
			wsPath: config.trojanPath,
			credential: config.trojanPassword,
			config,
			required: true,
		});
	}

	console.log('\n=== Diagnostics only: non-ECH controls ===');
	const selectedIp = reachable[0].ip;
	await runClientCase({
		label: `VLESS no-ECH @ ${selectedIp}`,
		host,
		ip: selectedIp,
		protocol: 'vless',
		ech: false,
		wsPath: config.vlessPath,
		credential: config.vlessUuid,
		config,
		required: false,
	});
	await runClientCase({
		label: `Trojan no-ECH @ ${selectedIp}`,
		host,
		ip: selectedIp,
		protocol: 'trojan',
		ech: false,
		wsPath: config.trojanPath,
		credential: config.trojanPassword,
		config,
		required: false,
	});
	if (haveGost) {
		// GOST's documented TLS settings do not expose the same ECH switch used by sing-box;
		// this is a no-ECH control, not a SOCKS5 protocol correctness verdict.
		const port = await findFreePort();
		const label = `SOCKS5/GOST no-ECH @ ${selectedIp}`;
		const logFile = path.join(tempDir, 'gost-control.log');
		const gostConf = gostConfig({ host, ip: selectedIp, port, config });
		const configFile = path.join(tempDir, 'gost-control.json');
		fs.writeFileSync(configFile, `${JSON.stringify(gostConf)}\n`, { mode: 0o600 });
		const child = spawn('gost', ['-C', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
		children.add(child);
		let output = '';
		const appendGostLog = (chunk) => {
			output = (output + chunk.toString()).slice(-8000);
			try {
				fs.appendFileSync(logFile, chunk, { mode: 0o600 });
			} catch {}
		};
		child.stdout.on('data', appendGostLog);
		child.stderr.on('data', appendGostLog);
		try {
			await waitForListener(port, child, logFile, sensitive);
			const outcome = await curlThroughSocks(port, targetUrl(SMALL_URL), { timeoutMs: 8000 }, sensitive);
			record({ label, required: false, ...outcome });
		} catch (error) {
			record({ label, required: false, ok: false, summary: 'no-ECH control could not connect', detail: redact(error.message, sensitive) });
		} finally {
			await stopChild(child);
			fs.rmSync(configFile, { force: true });
		}
	} else {
		console.log('SKIP GOST control: gost is not installed.');
	}

	console.log('\n=== SUMMARY ===');
	console.log(`Required ECH/integration checks: ${requiredPass} passed, ${requiredFail} failed.`);
	console.log(`Non-ECH controls (diagnostic only): ${controlPass} returned a response, ${controlFail} blocked/failed.`);
	console.log('A no-ECH timeout is a diagnostic network-path result; it does not by itself prove a Worker code defect.');
	console.log(
		'Required downloads follow HTTPS redirects and validate final HTTP 200 plus at least 1 MiB / 10 MiB of received data; the 10 MiB case must last at least 10 seconds.',
	);
	console.log('The Cloudflare-hosted destination check is diagnostic only and does not gate the ECH ingress result.');
	console.log('This is a single-network integration run, not a multi-hour stability guarantee.');
	if (requiredFail > 0) process.exitCode = 1;
}

let cleanupDone = false;
function cleanup() {
	if (cleanupDone) return;
	cleanupDone = true;
	for (const child of children) {
		try {
			child.kill('SIGKILL');
		} catch {}
	}
	if (!tempDir) return;
	if (KEEP_ARTIFACTS) {
		console.log(`Private integration artifacts retained at: ${tempDir}`);
	} else {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch (error) {
			console.error(`Warning: could not remove temporary test directory: ${error.message}`);
		}
	}
}

process.on('SIGINT', () => {
	cleanup();
	process.exit(130);
});
process.on('SIGTERM', () => {
	cleanup();
	process.exit(143);
});

try {
	await main();
} catch (error) {
	if (process.exitCode !== 2) process.exitCode = 1;
	if (error?.message) console.error(redact(error.message, []));
} finally {
	for (const child of [...children]) await stopChild(child);
	cleanup();
}
