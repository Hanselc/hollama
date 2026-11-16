import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_PLAUSIBLE_DOMAIN: { public: true, schema: (input) => input ?? '' },
	PUBLIC_PLAUSIBLE_API: { public: true, schema: (input) => input ?? '' },
	PUBLIC_PLAUSIBLE_SRC: { public: true, schema: (input) => input ?? '' },
	PUBLIC_ADAPTER: { public: true, schema: (input) => input ?? '' },
	PROXY_ALLOWED_HOSTS: { public: false, schema: (input) => input ?? '' },
	PROXY_ALLOW_INSECURE: { public: false, schema: (input) => input ?? '' }
});
