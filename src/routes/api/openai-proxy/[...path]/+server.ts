import { PROXY_ALLOW_INSECURE, PROXY_ALLOWED_HOSTS } from '$app/env/private';

import type { RequestHandler } from './$types';

const TARGET_HEADER = 'x-hollama-proxy-target';
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const FORWARDED_REQUEST_HEADERS = [
	'authorization',
	'content-type',
	'accept',
	'openai-organization',
	'openai-project',
	'user-agent',
	'accept-language'
];

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id', 'retry-after'];

const PRIVATE_HOSTNAMES = [
	/^localhost$/i,
	/\.localhost$/i,
	/\.local$/i,
	/\.internal$/i,
	/\.home\.arpa$/i,
	/^metadata$/i,
	/^metadata\./i
];

function errorResponse(message: string, status = 502) {
	return Response.json(
		{
			error: {
				message,
				type: 'proxy_error'
			}
		},
		{ status }
	);
}

function allowedHosts() {
	return String(PROXY_ALLOWED_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

function isIpLiteral(hostname: string) {
	const host = hostname.replace(/^\[|\]$/g, '');
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function isPrivateHostname(hostname: string) {
	return PRIVATE_HOSTNAMES.some((pattern) => pattern.test(hostname));
}

function isAllowedTarget(target: URL) {
	if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
	if (target.username || target.password) return false;

	if (target.protocol === 'http:' && String(PROXY_ALLOW_INSECURE ?? '').toLowerCase() !== 'true') {
		return false;
	}

	const hostname = target.hostname.toLowerCase();
	const allowlist = allowedHosts();
	if (allowlist.length) return allowlist.includes(hostname);

	return !isIpLiteral(hostname) && !isPrivateHostname(hostname);
}

function normalizePath(path: string | undefined) {
	const value = (path ?? '').replace(/^\/+|\/+$/g, '');
	if (!value) return undefined;

	const segments = value.split('/');
	if (
		segments.some(
			(segment) => !segment || segment === '.' || segment === '..' || /[\\?#]/.test(segment)
		)
	) {
		return undefined;
	}

	return value;
}

function isAllowedRequest(method: string, path: string) {
	if (method === 'GET') return path === 'models' || path.startsWith('models/');
	if (method === 'POST') return path === 'chat/completions' || path === 'responses';
	return false;
}

function proxyHeaders(request: Request, target: URL) {
	const headers = new Headers();

	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}

	headers.set('accept-encoding', 'identity');
	headers.set('user-agent', request.headers.get('user-agent') || `Hollama (${target.hostname})`);
	return headers;
}

function responseHeaders(response: Response) {
	const headers = new Headers();

	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}

	headers.set('cache-control', 'no-store');
	return headers;
}

function buildUpstreamUrl(target: URL, path: string, search: string) {
	const basePath = target.pathname.replace(/\/+$/, '');
	const upstream = new URL(`${basePath}/${path}`, target.origin);

	for (const [key, value] of target.searchParams) upstream.searchParams.set(key, value);
	for (const [key, value] of new URLSearchParams(search)) upstream.searchParams.set(key, value);

	return upstream;
}

async function requestBody(request: Request) {
	if (request.method === 'GET' || request.method === 'HEAD') return undefined;

	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
		throw new Error('Request body is too large');
	}

	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_REQUEST_BYTES) throw new Error('Request body is too large');
	return body;
}

async function proxy(request: Request, requestUrl: URL, path: string | undefined) {
	const targetValue = request.headers.get(TARGET_HEADER);
	if (!targetValue) return errorResponse(`Missing ${TARGET_HEADER} header`, 400);

	let target: URL;
	try {
		target = new URL(targetValue);
	} catch {
		return errorResponse('Invalid proxy target URL', 400);
	}

	if (!isAllowedTarget(target)) return errorResponse('Proxy target is not allowed', 400);

	const normalizedPath = normalizePath(path);
	if (!normalizedPath || !isAllowedRequest(request.method, normalizedPath)) {
		return errorResponse('Proxy path is not allowed', 404);
	}

	let body: ArrayBuffer | undefined;
	try {
		body = await requestBody(request);
	} catch (error) {
		return errorResponse(error instanceof Error ? error.message : String(error), 413);
	}

	let upstream = buildUpstreamUrl(target, normalizedPath, requestUrl.search);
	let method = request.method;
	let currentBody = body;

	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		let response: Response;
		try {
			response = await fetch(upstream, {
				method,
				headers: proxyHeaders(request, target),
				body: currentBody,
				redirect: 'manual',
				signal: request.signal
			});
		} catch (error) {
			if (request.signal.aborted) throw error;
			return errorResponse(
				error instanceof Error ? `Proxy request failed: ${error.message}` : 'Proxy request failed'
			);
		}

		const location = response.headers.get('location');
		if (!REDIRECT_STATUSES.has(response.status) || !location) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders(response)
			});
		}

		if (redirect === MAX_REDIRECTS) return errorResponse('Too many proxy redirects');

		let next: URL;
		try {
			next = new URL(location, upstream);
		} catch {
			return errorResponse('Invalid proxy redirect');
		}

		if (next.origin !== target.origin) {
			return errorResponse('Cross-origin proxy redirects are not allowed');
		}

		if (response.status === 303) {
			method = 'GET';
			currentBody = undefined;
		}

		upstream = next;
	}

	return errorResponse('Too many proxy redirects');
}

const handler: RequestHandler = ({ request, url, params }) => {
	return proxy(request, url, params.path);
};

export const GET = handler;
export const POST = handler;
