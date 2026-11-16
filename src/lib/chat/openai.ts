import OpenAI from 'openai';
import type {
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool
} from 'openai/resources/index.mjs';

import type { Server } from '#lib/connections.js';
import type { Model } from '#lib/settings.js';

import type { ChatChunk, ChatRequest, ChatResult, ChatStrategy, Message, ToolCall } from './index';

// Not part of OpenAI's spec: Ollama and OpenRouter stream reasoning as `reasoning`,
// DeepSeek and vLLM as `reasoning_content`.
type OpenAICompatibleDelta = ChatCompletionChunk.Choice.Delta & {
	reasoning?: string;
	reasoning_content?: string;
	function_call?: { name?: string; arguments?: string };
};

type OpenAIToolCallDelta = {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string | Record<string, unknown> };
};

function parseToolArguments(value: string | Record<string, unknown> | undefined) {
	if (!value) return {};
	if (typeof value === 'object') return value;

	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function toOpenAIToolCalls(toolCalls: ToolCall[]): ChatCompletionMessageToolCall[] {
	return toolCalls.map(
		(call) =>
			({
				id: call.id,
				type: 'function',
				function: {
					name: call.name,
					arguments: JSON.stringify(call.arguments)
				}
			}) as ChatCompletionMessageToolCall
	);
}

function toOpenAIMessage(message: Message): ChatCompletionMessageParam {
	if (message.role === 'tool') {
		return {
			role: 'tool',
			tool_call_id: message.toolCallId ?? '',
			content: message.content
		};
	}

	if (message.role === 'system') {
		return { role: 'system', content: message.content };
	}

	if (message.role === 'assistant') {
		return {
			role: 'assistant',
			content: message.content || (message.toolCalls?.length ? null : ''),
			...(message.toolCalls?.length ? { tool_calls: toOpenAIToolCalls(message.toolCalls) } : {})
		};
	}

	if (message.images && message.images.length > 0) {
		const content: ChatCompletionContentPart[] = [{ type: 'text', text: message.content }];
		message.images.forEach((img) => {
			let mimeType = 'image/jpeg';
			let base64Data = img;
			const dataUrlMatch = img.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.*)$/);
			if (dataUrlMatch) {
				mimeType = dataUrlMatch[1];
				base64Data = dataUrlMatch[2];
			}
			content.push({
				type: 'image_url',
				image_url: {
					url: `data:${mimeType};base64,${base64Data}`
				}
			});
		});
		// Vision API only supports user role for images currently
		return { role: 'user', content };
	}

	return { role: 'user', content: message.content };
}

export class OpenAIStrategy implements ChatStrategy {
	private openai: OpenAI;

	constructor(private server: Server) {
		this.openai = new OpenAI({
			baseURL: this.server.baseUrl,
			// The SDK rejects an empty key, but servers like llama.cpp don't need one
			apiKey: this.server.apiKey || 'none',
			dangerouslyAllowBrowser: true
		});
	}

	async chat(
		payload: ChatRequest,
		abortSignal: AbortSignal,
		onChunk: (chunk: ChatChunk) => void
	): Promise<ChatResult> {
		const messages = payload.messages.map(toOpenAIMessage);
		const tools = payload.tools as ChatCompletionTool[] | undefined;

		const response = await this.openai.chat.completions.create(
			{
				model: payload.model,
				messages,
				stream: true,
				...(tools?.length ? { tools, tool_choice: payload.toolChoice ?? ('auto' as const) } : {})
			},
			{ signal: abortSignal }
		);

		let content = '';
		let reasoning = '';
		const toolCallParts = new Map<number, { id?: string; name?: string; arguments: string }>();

		for await (const chunk of response) {
			if (abortSignal.aborted) break;

			const delta = chunk.choices[0]?.delta as OpenAICompatibleDelta | undefined;
			if (!delta) continue;

			const reasoningDelta = delta.reasoning || delta.reasoning_content;
			if (delta.content || reasoningDelta) {
				content += delta.content ?? '';
				reasoning += reasoningDelta ?? '';
				onChunk({ content: delta.content ?? undefined, reasoning: reasoningDelta });
			}

			const toolCallDeltas = (delta.tool_calls ?? []) as OpenAIToolCallDelta[];
			for (const [index, toolCall] of toolCallDeltas.entries()) {
				const position = toolCall.index ?? index;
				const existing = toolCallParts.get(position) ?? { arguments: '' };
				if (toolCall.id) existing.id = toolCall.id;
				if (toolCall.function?.name) existing.name = toolCall.function.name;
				if (toolCall.function?.arguments) {
					existing.arguments +=
						typeof toolCall.function.arguments === 'string'
							? toolCall.function.arguments
							: JSON.stringify(toolCall.function.arguments);
				}
				toolCallParts.set(position, existing);
			}

			if (delta.function_call) {
				const existing = toolCallParts.get(0) ?? { arguments: '' };
				if (delta.function_call.name) existing.name = delta.function_call.name;
				if (delta.function_call.arguments) existing.arguments += delta.function_call.arguments;
				toolCallParts.set(0, existing);
			}
		}

		const toolCalls: ToolCall[] = [...toolCallParts.entries()]
			.filter(([, part]) => part.name)
			.map(([index, part]) => ({
				id: part.id || `openai-${index}-${part.name}`,
				name: part.name!,
				arguments: parseToolArguments(part.arguments)
			}));

		return { content, reasoning, toolCalls };
	}

	async getModels(): Promise<Model[]> {
		const response = await this.openai.models.list();
		return response.data
			?.filter((model) => model.id.startsWith(this.server.modelFilter || ''))
			.map((model) => ({
				serverId: this.server.id,
				name: model.id
			}));
	}

	async verifyServer(): Promise<boolean> {
		try {
			await this.getModels();
			return true;
		} catch {
			return false;
		}
	}
}
