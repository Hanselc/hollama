<script lang="ts">
	import {
		AlertTriangle,
		Check,
		ChevronDown,
		ChevronUp,
		FileText,
		LoaderCircle,
		Search
	} from '@lucide/svelte';

	import type { ToolCallRecord } from '#lib/chat/index.js';
	import Button from '#lib/components/Button.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		toolCalls: ToolCallRecord[];
	}

	let { toolCalls }: Props = $props();
	let expandedId = $state<string | undefined>();

	function label(call: ToolCallRecord) {
		if (call.name === 'websearch') return m.webSearch();
		if (call.name === 'webfetch') return m.webFetch();
		return call.name;
	}

	function detail(call: ToolCallRecord) {
		const value = call.arguments.query ?? call.arguments.url;
		return typeof value === 'string' ? value : '';
	}

	function toggle(id: string) {
		expandedId = expandedId === id ? undefined : id;
	}
</script>

<div class="tool-calls">
	{#each toolCalls as call (call.id)}
		<div class="tool-call" data-testid="tool-call">
			<div class="tool-call__header">
				<div class="tool-call__status">
					{#if call.status === 'running'}
						<LoaderCircle class="base-icon animate-spin" />
					{:else if call.status === 'error'}
						<AlertTriangle class="base-icon text-warning" />
					{:else}
						<Check class="base-icon text-accent" />
					{/if}
				</div>

				<div class="tool-call__icon">
					{#if call.name === 'websearch'}
						<Search class="base-icon" />
					{:else}
						<FileText class="base-icon" />
					{/if}
				</div>

				<div class="tool-call__summary">
					<span class="tool-call__label">{label(call)}</span>
					<span class="tool-call__detail" title={detail(call)}>{detail(call)}</span>
				</div>

				{#if call.provider}
					<span class="tool-call__provider">{call.provider}</span>
				{/if}

				{#if call.result || call.error}
					<Button
						variant="icon"
						onclick={() => toggle(call.id)}
						title={expandedId === call.id ? m.hideToolResult() : m.showToolResult()}
						aria-label={expandedId === call.id ? m.hideToolResult() : m.showToolResult()}
					>
						{#if expandedId === call.id}
							<ChevronUp class="base-icon" />
						{:else}
							<ChevronDown class="base-icon" />
						{/if}
					</Button>
				{/if}
			</div>

			{#if expandedId === call.id}
				<div class="tool-call__result">
					{#if call.error}
						<p class="tool-call__error">{call.error}</p>
					{:else if call.result}
						<Markdown markdown={call.result} />
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style lang="postcss">
	.tool-calls {
		@apply flex w-full min-w-0 max-w-full flex-col gap-y-2;
	}

	.tool-call {
		@apply w-full min-w-0 max-w-full overflow-hidden rounded-md border border-shade-3 bg-shade-1 text-xs;
	}

	.tool-call__header {
		@apply flex min-w-0 items-center gap-2 px-2 py-1;
	}

	.tool-call__status,
	.tool-call__icon {
		@apply flex shrink-0 items-center text-muted;
	}

	.tool-call__summary {
		@apply flex min-w-0 flex-1 items-baseline gap-2;
	}

	.tool-call__label {
		@apply shrink-0 font-medium text-active;
	}

	.tool-call__detail {
		@apply min-w-0 truncate text-muted;
	}

	.tool-call__provider {
		@apply shrink-0 rounded bg-shade-2 px-1.5 py-0.5 uppercase tracking-wide text-muted;
	}

	.tool-call__result {
		@apply min-w-0 max-w-full overflow-x-auto border-t border-shade-3 px-3 py-2;
	}

	.tool-call__error {
		@apply break-words text-warning;
	}
</style>
