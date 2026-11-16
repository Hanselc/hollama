import { expect, test, type Page } from '@playwright/test';

import { chooseFromCombobox, chooseModel, MOCK_OPENAI_MODELS } from './utils';

const PROXY_MODELS_PATH = '**/api/openai-proxy/models';
const PROXY_CHAT_PATH = '**/api/openai-proxy/chat/completions';
const BASE_URL = 'https://ollama.com/v1/';
const API_KEY = 'sk-proxy-test';

async function addProxiedConnection(page: Page) {
	await page.goto('/settings');
	await chooseFromCombobox(page, 'Connection type', 'OpenAI: Compatible servers (i.e. llama.cpp)');
	await page.getByText('Add connection').click();
	await page.getByLabel('Base URL').fill(BASE_URL);
	await page.getByLabel('API Key').fill(API_KEY);

	const proxyCheckbox = page.getByLabel('Use Hollama proxy');
	await expect(proxyCheckbox).toBeVisible();
	await expect(proxyCheckbox).not.toBeChecked();
	await proxyCheckbox.check();
}

test.describe('OpenAI-compatible proxy', () => {
	test('verifies a connection through the proxy and saves the option', async ({ page }) => {
		await addProxiedConnection(page);

		let requestHeaders: Record<string, string> = {};
		await page.route(PROXY_MODELS_PATH, async (route) => {
			requestHeaders = route.request().headers();
			await route.fulfill({ json: { object: 'list', data: MOCK_OPENAI_MODELS } });
		});

		await page.getByRole('button', { name: 'Verify' }).click();
		await expect(page.getByText('Connection has been verified and is ready to use')).toBeVisible();

		expect(requestHeaders['x-hollama-proxy-target']).toBe(BASE_URL);
		expect(requestHeaders.authorization).toBe(`Bearer ${API_KEY}`);

		const servers = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('hollama-servers') || '[]')
		);
		expect(servers[0].useProxy).toBe(true);
	});

	test('streams chat completions through the proxy', async ({ page }) => {
		await addProxiedConnection(page);

		await page.route(PROXY_MODELS_PATH, async (route) => {
			await route.fulfill({ json: { object: 'list', data: MOCK_OPENAI_MODELS } });
		});
		await page.getByRole('button', { name: 'Verify' }).click();
		await expect(page.getByText('Connection has been verified and is ready to use')).toBeVisible();

		let chatHeaders: Record<string, string> = {};
		await page.route(PROXY_CHAT_PATH, async (route) => {
			chatHeaders = route.request().headers();
			const chunk = {
				id: 'chatcmpl-proxy',
				object: 'chat.completion.chunk',
				created: 1,
				model: 'gpt-3.5-turbo',
				choices: [
					{
						index: 0,
						delta: { content: 'Proxied response.' },
						finish_reason: 'stop'
					}
				]
			};
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `data: ${JSON.stringify(chunk)}\n\n`
			});
		});

		await page.getByRole('tab', { name: 'Sessions' }).click();
		await page.getByTestId('new-session').click();
		await chooseModel(page, 'gpt-3.5-turbo');
		await page.locator('.prompt-editor__textarea').fill('Hello through the proxy');
		await page.getByText('Run').click();

		await expect(page.getByText('Proxied response.')).toBeVisible();
		expect(chatHeaders['x-hollama-proxy-target']).toBe(BASE_URL);
		expect(chatHeaders.authorization).toBe(`Bearer ${API_KEY}`);
	});

	test('rejects missing, private, and unsupported proxy requests', async ({ page }) => {
		const missingTarget = await page.request.get('/api/openai-proxy/models');
		expect(missingTarget.status()).toBe(400);

		const privateTarget = await page.request.get('/api/openai-proxy/models', {
			headers: { 'x-hollama-proxy-target': 'http://127.0.0.1:1234/v1' }
		});
		expect(privateTarget.status()).toBe(400);

		const unsupportedPath = await page.request.get('/api/openai-proxy/admin', {
			headers: { 'x-hollama-proxy-target': 'https://example.com' }
		});
		expect(unsupportedPath.status()).toBe(404);

		const unsupportedMethod = await page.request.post('/api/openai-proxy/models', {
			headers: {
				'x-hollama-proxy-target': 'https://example.com',
				'content-type': 'application/json'
			},
			data: '{}'
		});
		expect(unsupportedMethod.status()).toBe(404);
	});
});
