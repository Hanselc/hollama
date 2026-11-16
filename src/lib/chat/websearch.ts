import type { Settings, WebSearchProvider } from '#lib/settings.js';

import { truncateText } from './html-to-markdown.js';

export interface WebSearchResult {
	title: string;
	url: string;
	content?: string;
	published?: string;
}

export interface WebSearchResponse {
	provider: WebSearchProvider;
	results: WebSearchResult[];
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_EXTRACT_CHARS = 40_000;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 2_000;
const TIMEOUT_MS = 25_000;

function getApiKey(settings: Settings) {
	const provider = settings.webSearchProvider ?? 'tavily';
	if (provider === 'exa') {
		return settings.exaApiKey?.trim() ? { provider, apiKey: settings.exaApiKey.trim() } : undefined;
	}
	return settings.tavilyApiKey?.trim()
		? { provider, apiKey: settings.tavilyApiKey.trim() }
		: undefined;
}

export function hasWebSearchProvider(settings: Settings) {
	return getApiKey(settings) !== undefined;
}

export function providerName(provider: WebSearchProvider) {
	return provider === 'exa' ? 'Exa' : 'Tavily';
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	abortSignal?: AbortSignal
): Promise<Response> {
	const signal = abortSignal
		? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)])
		: AbortSignal.timeout(TIMEOUT_MS);

	try {
		return await fetch(url, { ...init, signal });
	} catch (error) {
		if (abortSignal?.aborted && error instanceof DOMException && error.name === 'AbortError') {
			throw error;
		}
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new Error('Web request timed out', { cause: error });
		}
		if (error instanceof TypeError) {
			throw new Error('Web request failed. Check your network connection and API key.', {
				cause: error
			});
		}
		throw error;
	}
}

async function searchTavily(query: string, apiKey: string, abortSignal?: AbortSignal) {
	const response = await fetchWithTimeout(
		'https://api.tavily.com/search',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				query,
				search_depth: 'basic',
				chunks_per_source: 3,
				max_results: MAX_RESULTS,
				include_answer: false
			})
		},
		abortSignal
	);

	if (!response.ok) {
		throw new Error(`Tavily search failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as {
		results?: { title?: string; url?: string; content?: string; published_date?: string }[];
	};

	return (data.results ?? [])
		.filter((result) => result.url)
		.slice(0, MAX_RESULTS)
		.map((result) => ({
			title: result.title?.trim() || result.url!,
			url: result.url!,
			content: result.content?.trim(),
			published: result.published_date
		}));
}

async function searchExa(query: string, apiKey: string, abortSignal?: AbortSignal) {
	const response = await fetchWithTimeout(
		'https://api.exa.ai/search',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: JSON.stringify({
				query,
				numResults: MAX_RESULTS,
				type: 'auto',
				contents: {
					text: { maxCharacters: MAX_SNIPPET_CHARS }
				}
			})
		},
		abortSignal
	);

	if (!response.ok) {
		throw new Error(`Exa search failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as {
		results?: {
			title?: string;
			url?: string;
			text?: string;
			highlights?: string[];
			publishedDate?: string;
		}[];
	};

	return (data.results ?? [])
		.filter((result) => result.url)
		.slice(0, MAX_RESULTS)
		.map((result) => ({
			title: result.title?.trim() || result.url!,
			url: result.url!,
			content: (result.text || result.highlights?.join('\n') || '').trim() || undefined,
			published: result.publishedDate
		}));
}

async function extractTavily(
	url: string,
	format: 'markdown' | 'text' | 'html',
	apiKey: string,
	abortSignal?: AbortSignal
) {
	const response = await fetchWithTimeout(
		'https://api.tavily.com/extract',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				urls: [url],
				extract_depth: 'basic',
				format: format === 'text' ? 'text' : 'markdown',
				include_images: false
			})
		},
		abortSignal
	);

	if (!response.ok) {
		throw new Error(`Tavily extraction failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as {
		results?: { raw_content?: string }[];
		failed_results?: { error?: string }[];
	};
	const content = data.results?.find((result) => result.raw_content?.trim())?.raw_content;

	if (!content) {
		const failure = data.failed_results?.find((result) => result.error)?.error;
		throw new Error(
			failure ? `Tavily extraction failed: ${failure}` : 'Tavily returned no content'
		);
	}

	return {
		content: truncateText(content, MAX_EXTRACT_CHARS),
		contentType: format === 'text' ? 'text/plain' : 'text/markdown'
	};
}

async function extractExa(url: string, apiKey: string, abortSignal?: AbortSignal) {
	const response = await fetchWithTimeout(
		'https://api.exa.ai/contents',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: JSON.stringify({
				urls: [url],
				text: { maxCharacters: MAX_EXTRACT_CHARS }
			})
		},
		abortSignal
	);

	if (!response.ok) {
		throw new Error(`Exa extraction failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as {
		results?: { text?: string }[];
		statuses?: { status?: string; error?: string }[];
	};
	const content = data.results?.find((result) => result.text?.trim())?.text;

	if (!content) {
		const failure = data.statuses?.find((status) => status.error)?.error;
		throw new Error(failure ? `Exa extraction failed: ${failure}` : 'Exa returned no content');
	}

	return {
		content: truncateText(content, MAX_EXTRACT_CHARS),
		contentType: 'text/markdown'
	};
}

export async function extractWebPage(
	url: string,
	format: 'markdown' | 'text' | 'html',
	settings: Settings,
	abortSignal?: AbortSignal
): Promise<{ provider: WebSearchProvider; content: string; contentType: string }> {
	const configured = getApiKey(settings);
	if (!configured) {
		throw new Error('No web search API key configured');
	}

	const result =
		configured.provider === 'exa'
			? await extractExa(url, configured.apiKey, abortSignal)
			: await extractTavily(url, format, configured.apiKey, abortSignal);

	return { provider: configured.provider, ...result };
}

export async function searchWeb(
	query: string,
	settings: Settings,
	abortSignal?: AbortSignal
): Promise<{ provider: WebSearchProvider; results: WebSearchResult[] }> {
	const configured = getApiKey(settings);
	if (!configured) {
		throw new Error('No web search API key configured');
	}

	const results =
		configured.provider === 'exa'
			? await searchExa(query, configured.apiKey, abortSignal)
			: await searchTavily(query, configured.apiKey, abortSignal);

	return { provider: configured.provider, results };
}

export function formatWebSearchResults(
	query: string,
	provider: WebSearchProvider,
	results: WebSearchResult[]
) {
	if (!results.length) {
		return `No web search results found for "${query}".`;
	}

	const body = results
		.map((result) => {
			const published = result.published ? `\nPublished: ${result.published}` : '';
			const snippet = result.content
				? `\n\n${truncateText(result.content, MAX_SNIPPET_CHARS)}`
				: '';
			return `## [${result.title}](${result.url})${published}${snippet}`;
		})
		.join('\n\n---\n\n');

	return truncateText(
		`Web search results for "${query}" (${providerName(provider)}):\n\n${body}`,
		MAX_OUTPUT_CHARS
	);
}
