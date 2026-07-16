import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// Self-hosted Node deployment: `npm run build` emits ./build, run with
		// `node build` (set ORIGIN/PORT). See README "Deployment".
		adapter: adapter()
	}
};

export default config;
