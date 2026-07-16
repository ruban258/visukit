<script lang="ts">
	import { page } from '$app/stores';

	let { children } = $props();

	const routes = [
		{ href: '/', text: 'HMI' },
		{ href: '/trends', text: 'Trends' }
	];
	const active = (href: string) =>
		href === '/' ? $page.url.pathname === '/' : $page.url.pathname.startsWith(href);
</script>

<div class="app">
	<nav class="nav">
		<span class="brand">Visu<span class="accent">Kit</span></span>
		<span class="spacer"></span>
		{#each routes as r (r.href)}
			<a href={r.href} class:active={active(r.href)}>{r.text}</a>
		{/each}
	</nav>
	<main class="content">
		{@render children()}
	</main>
</div>

<style>
	:global(html),
	:global(body) {
		height: 100%;
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}
	.app {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.nav {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.5rem 1.25rem;
		border-bottom: 1px solid #e6e6e6;
	}
	.brand {
		font-weight: 700;
		font-size: 1.05rem;
		margin-right: 1rem;
	}
	.accent {
		color: #3b82f6;
	}
	.spacer {
		flex: 1;
	}
	.nav a {
		padding: 0.25rem 0.75rem;
		border-radius: 6px;
		text-decoration: none;
		color: #555;
		font-size: 0.9rem;
	}
	.nav a:hover {
		background: #f2f2f2;
	}
	.nav a.active {
		background: #3b82f6;
		color: #fff;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
</style>
