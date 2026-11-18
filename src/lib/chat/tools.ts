import type { Settings } from '#lib/settings.js';

import type { ToolCall, ToolDefinition } from './index.js';
import { webFetch, type WebFetchFormat } from './webfetch.js';
import {
	extractWebPage,
	formatWebSearchResults,
	hasWebSearchProvider,
	providerName,
	searchWeb
} from './websearch.js';

const CURRENT_YEAR = new Date().getFullYear();

export const WEB_FETCH_TOOL: ToolDefinition = {
	type: 'function',
	function: {
		name: 'webfetch',
		description: `Fetch a specific HTTP or HTTPS URL and return its content as text, markdown, or HTML. Markdown is the default. Use this when the user provides a URL or when a search result needs closer reading. This tool is read-only. If a site blocks direct browser fetches, the configured search provider is used as a fallback when available.`,
		parameters: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					description: 'The HTTP or HTTPS URL to fetch content from'
				},
				format: {
					type: 'string',
					enum: ['markdown', 'text', 'html'],
					description: 'The format to return. Defaults to markdown.'
				}
			},
			required: ['url']
		}
	}
};

export const WEB_SEARCH_TOOL: ToolDefinition = {
	type: 'function',
	function: {
		name: 'websearch',
		description: `Search the web for current information beyond your knowledge cutoff. Use this whenever the answer depends on recent events, live data, or facts you are unsure about. The current year is ${CURRENT_YEAR}.`,
		parameters: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'The web search query'
				}
			},
			required: ['query']
		}
	}
};

export function getWebTools(settings: Settings): ToolDefinition[] {
	return hasWebSearchProvider(settings) ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : [WEB_FETCH_TOOL];
}

export function getWebBrowsingSystemPrompt(settings: Settings) {
	const tools = hasWebSearchProvider(settings)
		? 'the websearch and webfetch tools'
		: 'the webfetch tool';

	return `Web browsing is enabled for this session. You have ${tools}. Use websearch on your own whenever the answer depends on current or recent information, and use webfetch to read a specific URL. Do not ask the user for permission before calling a tool. Cite sources as markdown links. If a tool fails, say so and continue with the best information available. Do not use tools for timeless questions you can answer confidently.`;
}

function readStringArgument(args: Record<string, unknown>, key: string) {
	const value = args[key];
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Missing required argument: ${key}`);
	}
	return value.trim();
}

function readFormatArgument(args: Record<string, unknown>): WebFetchFormat {
	const value = args.format;
	return value === 'text' || value === 'html' ? value : 'markdown';
}

export async function executeWebTool(
	call: ToolCall,
	settings: Settings,
	abortSignal?: AbortSignal
): Promise<{ content: string; provider?: string }> {
	switch (call.name) {
		case 'websearch': {
			const query = readStringArgument(call.arguments, 'query');
			const { provider, results } = await searchWeb(query, settings, abortSignal);
			return {
				content: formatWebSearchResults(query, provider, results),
				provider
			};
		}
		case 'webfetch': {
			const url = readStringArgument(call.arguments, 'url');
			const format = readFormatArgument(call.arguments);

			try {
				const result = await webFetch(url, format, abortSignal);
				return {
					content: `URL: ${result.url}\nContent-Type: ${result.contentType || 'unknown'}\n\n${result.output}`
				};
			} catch (error) {
				if (abortSignal?.aborted) throw error;
				if (!hasWebSearchProvider(settings)) throw error;

				try {
					const fallback = await extractWebPage(url, format, settings, abortSignal);
					const name = providerName(fallback.provider);
					return {
						content: `URL: ${url}\nContent-Type: ${fallback.contentType}\nProvider: ${name} (fallback)\n\n${fallback.content}`,
						provider: fallback.provider
					};
				} catch (fallbackError) {
					if (abortSignal?.aborted) throw fallbackError;

					const directMessage = error instanceof Error ? error.message : String(error);
					const fallbackMessage =
						fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
					const name = providerName(settings.webSearchProvider ?? 'tavily');

					throw new Error(
						`Could not fetch ${url} directly (${directMessage}). ${name} fallback also failed (${fallbackMessage}).`,
						{ cause: fallbackError }
					);
				}
			}
		}
		default:
			throw new Error(`Unknown tool: ${call.name}`);
	}
}
