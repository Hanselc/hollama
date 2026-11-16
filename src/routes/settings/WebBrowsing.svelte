<script lang="ts">
	import Button from '#lib/components/Button.svelte';
	import FieldHelp from '#lib/components/FieldHelp.svelte';
	import FieldInput from '#lib/components/FieldInput.svelte';
	import FieldSelect from '#lib/components/FieldSelect.svelte';
	import Fieldset from '#lib/components/Fieldset.svelte';
	import P from '#lib/components/P.svelte';
	import { settingsStore } from '#lib/localStorage.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { WebSearchProvider } from '#lib/settings.js';

	let provider: WebSearchProvider = $state($settingsStore.webSearchProvider ?? 'tavily');

	function changeProvider() {
		$settingsStore.webSearchProvider = provider;
	}
</script>

<Fieldset>
	<P><strong>{m.webBrowsing()}</strong></P>
	<P>{m.webBrowsingDescription()}</P>

	<FieldSelect
		name="webSearchProvider"
		label={m.webSearchProvider()}
		bind:value={provider}
		allowClear={false}
		allowSearch={false}
		onChange={changeProvider}
		options={[
			{ value: 'tavily', label: 'Tavily' },
			{ value: 'exa', label: 'Exa' }
		]}
	/>

	{#if provider === 'tavily'}
		<FieldInput
			type="password"
			name="tavilyApiKey"
			label={m.tavilyApiKey()}
			bind:value={$settingsStore.tavilyApiKey}
			placeholder={m.noApiKey()}
		>
			<svelte:fragment slot="help">
				<FieldHelp>
					<P>{m.webSearchKeysHelp()}</P>
					<P>
						<Button variant="link" href="https://app.tavily.com/home" target="_blank">
							{m.howToObtainTavilyKey()}
						</Button>
					</P>
				</FieldHelp>
			</svelte:fragment>
		</FieldInput>
	{:else}
		<FieldInput
			type="password"
			name="exaApiKey"
			label={m.exaApiKey()}
			bind:value={$settingsStore.exaApiKey}
			placeholder={m.noApiKey()}
		>
			<svelte:fragment slot="help">
				<FieldHelp>
					<P>{m.webSearchKeysHelp()}</P>
					<P>
						<Button variant="link" href="https://dashboard.exa.ai/api-keys" target="_blank">
							{m.howToObtainExaKey()}
						</Button>
					</P>
				</FieldHelp>
			</svelte:fragment>
		</FieldInput>
	{/if}
</Fieldset>
