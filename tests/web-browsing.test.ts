import { expect, test, type Page, type Route } from '@playwright/test';

import {
	chooseModel,
	MOCK_API_TAGS_RESPONSE,
	MOCK_OPENAI_MODELS,
	MOCK_SESSION_1_RESPONSE_1,
	mockOllamaModelsResponse,
	mockOpenAIModelsResponse
} from './utils';

const TAVILY_RESULT = {
	title: 'Example article',
	url: 'https://example.com/article',
	content: 'A recent and relevant search result.'
};

async function seedWebSearch(
	page: Page,
	provider: 'tavily' | 'exa' = 'tavily',
	key = 'test-web-search-key'
) {
	await page.evaluate(
		({ provider, key }) => {
			const settings = JSON.parse(localStorage.getItem('hollama-settings') || '{}');
			settings.webSearchProvider = provider;
			if (provider === 'tavily') settings.tavilyApiKey = key;
			else settings.exaApiKey = key;
			localStorage.setItem('hollama-settings', JSON.stringify(settings));
		},
		{ provider, key }
	);
	await page.reload();
}

async function openBrowsingSession(page: Page, prompt: string) {
	await page.getByRole('tab', { name: 'Sessions' }).click();
	await page.getByTestId('new-session').click();
	await chooseModel(page, MOCK_API_TAGS_RESPONSE.models[0].name);

	const toggle = page.getByTestId('web-browsing-toggle');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');

	await page.locator('.prompt-editor__textarea').fill(prompt);
}

function ollamaStream(lines: unknown[]) {
	return lines.map((line) => JSON.stringify(line)).join('\n');
}

async function mockWebFetchToolLoop(page: Page, url: string, finalText: string) {
	const requests: Record<string, unknown>[] = [];

	await page.route('**/api/chat', async (route) => {
		const request = JSON.parse(route.request().postData() || '{}');
		requests.push(request);

		if (requests.length === 1) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: ollamaStream([
					{
						message: {
							role: 'assistant',
							content: '',
							tool_calls: [
								{
									id: 'call-fetch',
									function: {
										name: 'webfetch',
										arguments: { url }
									}
								}
							]
						},
						done: false
					},
					{ message: { role: 'assistant', content: '' }, done: true }
				])
			});
			return;
		}

		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				...MOCK_SESSION_1_RESPONSE_1,
				message: { role: 'assistant', content: finalText }
			})
		});
	});

	return requests;
}

test.describe('Web browsing', () => {
	test('saves the selected search provider and API key', async ({ page }) => {
		await page.goto('/settings');

		await page.getByLabel('Search provider').click();
		await page.getByRole('option', { name: 'Exa' }).click();
		await page.getByLabel('Exa key').fill('exa-test-key');

		const settings = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('hollama-settings') || '{}')
		);
		expect(settings.webSearchProvider).toBe('exa');
		expect(settings.exaApiKey).toBe('exa-test-key');

		await page.reload();
		await expect(page.getByLabel('Exa key')).toHaveValue('exa-test-key');
	});

	test('only sends web tools when browsing is enabled', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await seedWebSearch(page);
		await openBrowsingSession(page, 'What happened in the news today?');

		let firstRequest: Record<string, unknown> | undefined;
		await page.route('**/api/chat', async (route) => {
			firstRequest = JSON.parse(route.request().postData() || '{}');
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(MOCK_SESSION_1_RESPONSE_1)
			});
		});

		await page.getByText('Run').click();

		await expect(page.getByText(MOCK_SESSION_1_RESPONSE_1.message.content)).toBeVisible();
		expect(firstRequest).toBeDefined();

		const tools = firstRequest?.tools as { function: { name: string } }[];
		expect(tools.map((tool) => tool.function.name)).toEqual(['websearch', 'webfetch']);
		expect(JSON.stringify(firstRequest?.messages)).toContain('Web browsing is enabled');
	});

	test('omits web search when the selected provider has no key', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await openBrowsingSession(page, 'Read this page');

		let firstRequest: Record<string, unknown> | undefined;
		await page.route('**/api/chat', async (route) => {
			firstRequest = JSON.parse(route.request().postData() || '{}');
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(MOCK_SESSION_1_RESPONSE_1)
			});
		});

		await page.getByText('Run').click();
		await expect(page.getByText(MOCK_SESSION_1_RESPONSE_1.message.content)).toBeVisible();

		const tools = firstRequest?.tools as { function: { name: string } }[];
		expect(tools.map((tool) => tool.function.name)).toEqual(['webfetch']);
	});

	test('runs an Ollama search tool and sends the result back to the model', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await seedWebSearch(page);
		await openBrowsingSession(page, 'What is the latest news?');

		await page.route('https://api.tavily.com/search', async (route) => {
			await route.fulfill({
				status: 200,
				json: { results: [TAVILY_RESULT] }
			});
		});

		const requests: Record<string, unknown>[] = [];
		await page.route('**/api/chat', async (route) => {
			const request = JSON.parse(route.request().postData() || '{}');
			requests.push(request);

			if (requests.length === 1) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: ollamaStream([
						{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [
									{
										id: 'call-search',
										function: {
											name: 'websearch',
											arguments: { query: 'latest news' }
										}
									}
								]
							},
							done: false
						},
						{ message: { role: 'assistant', content: '' }, done: true }
					])
				});
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					...MOCK_SESSION_1_RESPONSE_1,
					message: {
						role: 'assistant',
						content: 'Here is the latest news from [Example](https://example.com/article).'
					}
				})
			});
		});

		await page.getByText('Run').click();

		await expect(page.getByText('Here is the latest news from', { exact: false })).toBeVisible();
		await expect(page.getByTestId('tool-call')).toHaveCount(1);
		await expect(page.getByTestId('tool-call')).toContainText('Web search');
		await expect(page.getByTestId('tool-call')).toContainText('latest news');

		const secondMessages = requests[1].messages as {
			role: string;
			content: string;
			tool_name?: string;
		}[];
		const toolMessage = secondMessages.find((message) => message.role === 'tool');
		expect(toolMessage?.content).toContain('A recent and relevant search result.');
		expect(toolMessage?.tool_name).toBe('websearch');

		const assistant = secondMessages.find(
			(message) =>
				message.role === 'assistant' && (message as { tool_calls?: unknown[] }).tool_calls
		);
		expect(assistant).toBeDefined();
	});

	test('fetches a page and converts HTML to markdown', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await seedWebSearch(page);
		await openBrowsingSession(page, 'Read https://cors.example/page');

		let fallbackCalled = false;
		await page.route('https://api.tavily.com/extract', async (route) => {
			fallbackCalled = true;
			await route.fulfill({ status: 500, json: { detail: { error: 'not used' } } });
		});

		await page.route('https://cors.example/page', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: '<html><body><h1>Hello</h1><p>World</p><a href="/next">Next page</a><script>bad()</script></body></html>'
			});
		});

		const requests: Record<string, unknown>[] = [];
		await page.route('**/api/chat', async (route) => {
			const request = JSON.parse(route.request().postData() || '{}');
			requests.push(request);

			if (requests.length === 1) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: ollamaStream([
						{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [
									{
										id: 'call-fetch',
										function: {
											name: 'webfetch',
											arguments: { url: 'https://cors.example/page' }
										}
									}
								]
							},
							done: false
						},
						{ message: { role: 'assistant', content: '' }, done: true }
					])
				});
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					...MOCK_SESSION_1_RESPONSE_1,
					message: { role: 'assistant', content: 'The page says Hello World.' }
				})
			});
		});

		await page.getByText('Run').click();

		await expect(page.getByText('The page says Hello World.')).toBeVisible();
		const toolMessage = (requests[1].messages as { role: string; content: string }[]).find(
			(message) => message.role === 'tool'
		);
		expect(toolMessage?.content).toContain('# Hello');
		expect(toolMessage?.content).toContain('World');
		expect(toolMessage?.content).toContain('[Next page](https://cors.example/next)');
		expect(toolMessage?.content).not.toContain('bad()');
		expect(fallbackCalled).toBe(false);
	});

	test('falls back to Tavily extract when direct fetch is blocked', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await seedWebSearch(page);
		await openBrowsingSession(page, 'Read https://blocked.example/page');

		await page.route('https://blocked.example/page', (route) => route.abort('failed'));

		let extractRequest: Record<string, unknown> | undefined;
		let extractAuthorization: string | undefined;
		await page.route('https://api.tavily.com/extract', async (route) => {
			extractRequest = JSON.parse(route.request().postData() || '{}');
			extractAuthorization = route.request().headers()['authorization'];
			await route.fulfill({
				status: 200,
				json: {
					results: [{ raw_content: '# Tavily fallback\n\nExtracted content.' }],
					failed_results: []
				}
			});
		});

		const requests = await mockWebFetchToolLoop(
			page,
			'https://blocked.example/page',
			'Tavily fallback worked.'
		);
		await page.getByText('Run').click();

		await expect(page.getByText('Tavily fallback worked.')).toBeVisible();
		await expect(page.getByTestId('tool-call')).toContainText(/tavily/i);

		const toolMessage = (requests[1].messages as { role: string; content: string }[]).find(
			(message) => message.role === 'tool'
		);
		expect(toolMessage?.content).toContain('Tavily fallback');
		expect(toolMessage?.content).toContain('Provider: Tavily (fallback)');
		expect(extractRequest?.urls).toEqual(['https://blocked.example/page']);
		expect(extractAuthorization).toBe('Bearer test-web-search-key');
	});

	test('falls back to Exa contents when direct fetch is blocked', async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await seedWebSearch(page, 'exa');
		await openBrowsingSession(page, 'Read https://blocked.example/page');

		await page.route('https://blocked.example/page', (route) => route.abort('failed'));

		let extractRequest: Record<string, unknown> | undefined;
		let extractApiKey: string | undefined;
		await page.route('https://api.exa.ai/contents', async (route) => {
			extractRequest = JSON.parse(route.request().postData() || '{}');
			extractApiKey = route.request().headers()['x-api-key'];
			await route.fulfill({
				status: 200,
				json: {
					results: [{ text: '# Exa fallback\n\nExtracted content.' }],
					statuses: [{ status: 'success' }]
				}
			});
		});

		const requests = await mockWebFetchToolLoop(
			page,
			'https://blocked.example/page',
			'Exa fallback worked.'
		);
		await page.getByText('Run').click();

		await expect(page.getByText('Exa fallback worked.')).toBeVisible();
		await expect(page.getByTestId('tool-call')).toContainText(/exa/i);

		const toolMessage = (requests[1].messages as { role: string; content: string }[]).find(
			(message) => message.role === 'tool'
		);
		expect(toolMessage?.content).toContain('Exa fallback');
		expect(toolMessage?.content).toContain('Provider: Exa (fallback)');
		expect(extractRequest?.urls).toEqual(['https://blocked.example/page']);
		expect(extractApiKey).toBe('test-web-search-key');
	});

	test('does not overflow horizontally on mobile with web tools', async ({ page }) => {
		const longWord = 'a'.repeat(400);
		const longUrl = `https://cors.example/${longWord}`;

		await page.addInitScript(
			({ longWord, longUrl }) => {
				localStorage.setItem(
					'hollama-settings',
					JSON.stringify({
						models: [],
						lastUsedModels: [],
						sidebarExpanded: false
					})
				);
				localStorage.setItem(
					'hollama-sessions',
					JSON.stringify([
						{
							id: 'mobile-overflow',
							model: { serverId: 'test-server', name: 'test-model' },
							systemPrompt: { role: 'system', content: '' },
							options: {},
							webBrowsing: true,
							messages: [
								{ role: 'user', content: 'Read the page' },
								{
									role: 'assistant',
									content: `Mobile answer ${'word '.repeat(100)}`,
									toolCalls: [
										{
											id: 'call-fetch',
											name: 'webfetch',
											arguments: { url: longUrl },
											status: 'completed',
											result: `# ${longWord}\n\n${longWord}\n\n| Value |\n| --- |\n| ${longWord} |`
										}
									]
								}
							]
						}
					])
				);
			},
			{ longWord, longUrl }
		);

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/sessions/mobile-overflow');

		await expect(page.getByTestId('tool-call')).toHaveCount(1);
		await expect(page.getByText(/Mobile answer/)).toBeVisible();

		const getHorizontalOverflow = () =>
			page.evaluate(() => {
				const history = document.querySelector('.session__history');
				return history ? history.scrollWidth - history.clientWidth : -1;
			});

		expect(await getHorizontalOverflow()).toBeLessThanOrEqual(1);

		const showResult = page.getByRole('button', { name: 'Show result' });
		await showResult.scrollIntoViewIfNeeded();
		await showResult.click();
		await expect(page.getByTestId('tool-call')).toContainText(longWord.slice(0, 50));
		expect(await getHorizontalOverflow()).toBeLessThanOrEqual(1);

		const answerRight = await page
			.getByText(/Mobile answer/)
			.evaluate((element) => element.getBoundingClientRect().right);
		expect(answerRight).toBeLessThanOrEqual(375);
	});

	test('parses streamed OpenAI tool calls', async ({ page }) => {
		await mockOpenAIModelsResponse(page, MOCK_OPENAI_MODELS);
		await seedWebSearch(page);

		await page.getByRole('tab', { name: 'Sessions' }).click();
		await page.getByTestId('new-session').click();
		await chooseModel(page, 'gpt-3.5-turbo');

		const toggle = page.getByTestId('web-browsing-toggle');
		await toggle.click();
		await page.locator('.prompt-editor__textarea').fill('What is the latest news?');

		await page.route('https://api.tavily.com/search', async (route) => {
			await route.fulfill({ status: 200, json: { results: [TAVILY_RESULT] } });
		});

		const requests: Record<string, unknown>[] = [];
		await page.route('**/v1/chat/completions', async (route: Route) => {
			const request = JSON.parse(route.request().postData() || '{}');
			requests.push(request);

			if (requests.length === 1) {
				const chunks = [
					{
						id: 'chatcmpl-tool',
						object: 'chat.completion.chunk',
						created: 1,
						model: 'gpt-3.5-turbo',
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'call-openai',
											type: 'function',
											function: {
												name: 'websearch',
												arguments: '{"query":"latest news"}'
											}
										}
									]
								},
								finish_reason: null
							}
						]
					},
					{
						id: 'chatcmpl-tool',
						object: 'chat.completion.chunk',
						created: 1,
						model: 'gpt-3.5-turbo',
						choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
					}
				];
				await route.fulfill({
					status: 200,
					contentType: 'text/event-stream',
					body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
				});
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `data: ${JSON.stringify({
					id: 'chatcmpl-final',
					object: 'chat.completion.chunk',
					created: 1,
					model: 'gpt-3.5-turbo',
					choices: [
						{
							index: 0,
							delta: { content: 'OpenAI browsed the web.' },
							finish_reason: 'stop'
						}
					]
				})}\n\n`
			});
		});

		await page.getByText('Run').click();

		await expect(page.getByText('OpenAI browsed the web.')).toBeVisible();
		expect(requests[0].tools).toBeDefined();
		expect(requests[0].tool_choice).toBe('auto');

		const secondMessages = requests[1].messages as { role: string; tool_call_id?: string }[];
		const toolMessage = secondMessages.find((message) => message.role === 'tool');
		expect(toolMessage?.tool_call_id).toBe('call-openai');
	});
});
