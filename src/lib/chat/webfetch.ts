import { htmlToMarkdown, htmlToText, truncateText } from './html-to-markdown.js';

export type WebFetchFormat = 'markdown' | 'text' | 'html';

export interface WebFetchResult {
	url: string;
	contentType: string;
	format: WebFetchFormat;
	output: string;
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const ACCEPT_HEADERS: Record<WebFetchFormat, string> = {
	markdown:
		'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
	text: 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1',
	html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1'
};

async function readBoundedText(response: Response) {
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = '';

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;

			const remaining = MAX_RESPONSE_BYTES - received;
			if (remaining <= 0) break;

			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			received += chunk.byteLength;
			text += decoder.decode(chunk, { stream: true });

			if (received >= MAX_RESPONSE_BYTES) break;
		}
	} finally {
		reader.releaseLock();
	}

	return text + decoder.decode();
}

function isTextualContentType(contentType: string) {
	const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
	if (!type || type.startsWith('text/')) return true;
	return (
		type === 'application/json' ||
		type === 'application/xml' ||
		type === 'application/xhtml+xml' ||
		type.endsWith('+json') ||
		type.endsWith('+xml')
	);
}

function convertContent(content: string, contentType: string, format: WebFetchFormat, url: string) {
	const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
	const isHtml = type === 'text/html' || type === 'application/xhtml+xml';

	if (!isHtml || format === 'html') return content;
	if (format === 'markdown') return htmlToMarkdown(content, url);
	return htmlToText(content);
}

function fetchErrorMessage(error: unknown, url: string) {
	if (error instanceof DOMException && error.name === 'TimeoutError') {
		return `Request to ${url} timed out`;
	}
	if (error instanceof TypeError) {
		return `Could not fetch ${url}. The site may not allow cross-origin requests (CORS) or the network request failed.`;
	}
	return error instanceof Error ? error.message : String(error);
}

export async function webFetch(
	url: string,
	format: WebFetchFormat,
	abortSignal?: AbortSignal
): Promise<WebFetchResult> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}

	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		throw new Error('Only http:// and https:// URLs are supported');
	}
	if (target.username || target.password) {
		throw new Error('URLs with credentials are not supported');
	}

	const signal = abortSignal
		? AbortSignal.any([abortSignal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
		: AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(target.toString(), {
			method: 'GET',
			headers: {
				Accept: ACCEPT_HEADERS[format]
			},
			redirect: 'follow',
			signal
		});
	} catch (error) {
		if (abortSignal?.aborted && error instanceof DOMException && error.name === 'AbortError') {
			throw error;
		}
		throw new Error(fetchErrorMessage(error, target.toString()), { cause: error });
	}

	if (!response.ok) {
		throw new Error(`Request to ${target.toString()} failed with HTTP ${response.status}`);
	}

	const contentType = response.headers.get('content-type') ?? '';
	if (!isTextualContentType(contentType)) {
		throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
	}

	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error('Response is too large to fetch');
	}

	let body: string;
	try {
		body = await readBoundedText(response);
	} catch (error) {
		if (abortSignal?.aborted && error instanceof DOMException && error.name === 'AbortError') {
			throw error;
		}
		throw new Error(fetchErrorMessage(error, target.toString()), { cause: error });
	}

	const output = convertContent(body, contentType, format, target.toString());
	return {
		url: target.toString(),
		contentType,
		format,
		output: truncateText(output, MAX_OUTPUT_CHARS)
	};
}
