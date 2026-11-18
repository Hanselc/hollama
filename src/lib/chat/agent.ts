import type {
	ChatChunk,
	ChatRequest,
	ChatStrategy,
	Message,
	ToolCall,
	ToolCallRecord,
	ToolDefinition
} from './index.js';

export interface AgentOptions {
	strategy: ChatStrategy;
	request: ChatRequest;
	tools: ToolDefinition[];
	signal: AbortSignal;
	executeTool: (
		call: ToolCall,
		signal: AbortSignal
	) => Promise<{ content: string; provider?: string }>;
	onChunk: (chunk: ChatChunk) => void | Promise<void>;
	onToolCall?: (call: ToolCallRecord) => void;
	maxSteps?: number;
}

export async function runChatAgent({
	strategy,
	request,
	tools,
	signal,
	executeTool,
	onChunk,
	onToolCall,
	maxSteps = 8
}: AgentOptions): Promise<ToolCallRecord[]> {
	const messages: Message[] = [...request.messages];
	const toolCalls: ToolCallRecord[] = [];

	for (let step = 0; step <= maxSteps; step++) {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

		const isFinalStep = step === maxSteps;
		const result = await strategy.chat(
			{
				...request,
				messages,
				tools: isFinalStep ? undefined : tools,
				toolChoice: isFinalStep ? undefined : 'auto'
			},
			signal,
			onChunk
		);

		if (!result.toolCalls.length || isFinalStep) break;

		messages.push({
			role: 'assistant',
			content: result.content,
			toolCalls: result.toolCalls
		});

		for (const call of result.toolCalls) {
			const record: ToolCallRecord = { ...call, status: 'running' };
			toolCalls.push(record);
			onToolCall?.(record);

			let output = '';
			try {
				const result = await executeTool(call, signal);
				output = result.content;
				record.status = 'completed';
				record.result = result.content;
				record.provider = result.provider;
			} catch (error) {
				if (signal.aborted) throw error;

				const message = error instanceof Error ? error.message : String(error);
				output = `Tool "${call.name}" failed: ${message}`;
				record.status = 'error';
				record.error = message;
			}

			onToolCall?.(record);
			messages.push({
				role: 'tool',
				content: output,
				toolCallId: call.id,
				toolName: call.name
			});
		}
	}

	return toolCalls;
}
