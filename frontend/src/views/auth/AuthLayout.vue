<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconCloudDataConnection, IconCheck, IconMoon, IconSun, IconLanguage } from '@tabler/icons-vue';
import { setLocale } from '../../i18n';

defineProps({
	title: { type: String, default: '' },
	subtitle: { type: String, default: '' },
});

const { t, locale } = useI18n();

const features = ['auth.feature1', 'auth.feature2', 'auth.feature3'];

const isDark = ref(document.documentElement.classList.contains('dark'));
const nextLanguageLabel = computed(() => (locale.value === 'es' ? 'EN' : 'ES'));

function toggleTheme() {
	const next = isDark.value ? 'light' : 'dark';
	isDark.value = !isDark.value;
	document.documentElement.classList.toggle('dark', next === 'dark');
	window.localStorage.setItem('omnicloud-theme', next);
}

function toggleLanguage() {
	setLocale(locale.value === 'es' ? 'en' : 'es');
}
</script>

<template>
	<div class="auth-shell">
		<div class="auth-controls">
			<button type="button" class="auth-control" :title="t('common.language')" :aria-label="t('common.language')" @click="toggleLanguage">
				<IconLanguage :size="18" :stroke="2" />
				<span class="auth-control__text">{{ nextLanguageLabel }}</span>
			</button>
			<button type="button" class="auth-control auth-control--icon" :title="t('header.toggleTheme')" :aria-label="t('header.toggleTheme')" @click="toggleTheme">
				<IconSun v-if="isDark" :size="18" :stroke="2" />
				<IconMoon v-else :size="18" :stroke="2" />
			</button>
		</div>

		<aside class="auth-hero">
			<div class="auth-hero__glow auth-hero__glow--one" />
			<div class="auth-hero__glow auth-hero__glow--two" />

			<div class="auth-hero__top">
				<span class="auth-hero__logo">
					<IconCloudDataConnection :size="26" :stroke="2" />
				</span>
				<span class="auth-hero__brand">OmniCloud</span>
			</div>

			<div class="auth-hero__body">
				<h2 class="auth-hero__headline">{{ t('auth.brandHeadline') }}</h2>
				<p class="auth-hero__subtext">{{ t('auth.brandSubtext') }}</p>

				<ul class="auth-hero__features">
					<li v-for="feature in features" :key="feature">
						<span class="auth-hero__check">
							<IconCheck :size="14" :stroke="3" />
						</span>
						{{ t(feature) }}
					</li>
				</ul>
			</div>

			<p class="auth-hero__foot">
				© {{ new Date().getFullYear() }} OmniCloud. {{ t('auth.footerMadeBy') }}
				<a href="https://github.com/dimartarmizi" target="_blank" rel="noreferrer">Dimar Tarmizi</a>.
				{{ t('auth.footerOpenSourcePrefix') }} <a href="https://github.com/dimartarmizi/OmniCloud" target="_blank" rel="noreferrer">{{ t('auth.footerOpenSource') }}</a>.
			</p>
		</aside>

		<main class="auth-panel">
			<div class="auth-panel__inner">
				<div class="auth-panel__brand">
					<span class="auth-panel__logo">
						<IconCloudDataConnection :size="22" :stroke="2" />
					</span>
					<span>OmniCloud</span>
				</div>

				<header class="auth-panel__head">
					<h1>{{ title }}</h1>
					<p v-if="subtitle">{{ subtitle }}</p>
				</header>

				<slot />
			</div>
		</main>
	</div>
</template>

<style scoped>
.auth-shell {
	min-height: 100vh;
	display: grid;
	grid-template-columns: 1fr;
	background: #f4f6fb;
	position: relative;
}

.auth-controls {
	position: absolute;
	top: 1.25rem;
	right: 1.25rem;
	z-index: 20;
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.auth-control {
	display: inline-flex;
	align-items: center;
	gap: 0.4rem;
	height: 2.5rem;
	padding: 0 0.85rem;
	border: 1px solid rgba(148, 163, 184, 0.35);
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.75);
	backdrop-filter: blur(8px);
	color: #334155;
	font-size: 0.82rem;
	font-weight: 600;
	cursor: pointer;
	transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}

.auth-control--icon {
	padding: 0;
	width: 2.5rem;
	justify-content: center;
}

.auth-control:hover {
	transform: translateY(-1px);
	border-color: #2563eb;
	color: #2563eb;
	background: rgba(255, 255, 255, 0.95);
}

.auth-control__text {
	letter-spacing: 0.04em;
}

@media (min-width: 960px) {
	.auth-controls {
		color: #fff;
	}
}

.dark .auth-control {
	border-color: rgba(148, 163, 184, 0.25);
	background: rgba(17, 26, 46, 0.7);
	color: #cbd5e1;
}

.dark .auth-control:hover {
	border-color: #3b82f6;
	color: #93c5fd;
	background: rgba(17, 26, 46, 0.95);
}

@media (min-width: 960px) {
	.auth-shell {
		grid-template-columns: 1.05fr 1fr;
	}
}

.auth-hero {
	position: relative;
	display: none;
	flex-direction: column;
	justify-content: space-between;
	padding: 3rem;
	overflow: hidden;
	color: #eef2ff;
	background: linear-gradient(150deg, #1d4ed8 0%, #2563eb 38%, #4f46e5 100%);
}

@media (min-width: 960px) {
	.auth-hero {
		display: flex;
	}
}

.auth-hero__glow {
	position: absolute;
	border-radius: 50%;
	filter: blur(10px);
	opacity: 0.55;
	pointer-events: none;
}

.auth-hero__glow--one {
	width: 26rem;
	height: 26rem;
	top: -8rem;
	right: -6rem;
	background: radial-gradient(circle, rgba(255, 255, 255, 0.35), transparent 65%);
}

.auth-hero__glow--two {
	width: 22rem;
	height: 22rem;
	bottom: -7rem;
	left: -5rem;
	background: radial-gradient(circle, rgba(129, 140, 248, 0.55), transparent 65%);
}

.auth-hero__top {
	position: relative;
	display: flex;
	align-items: center;
	gap: 0.65rem;
	font-size: 1.25rem;
	font-weight: 600;
	letter-spacing: 0.01em;
}

.auth-hero__logo {
	display: grid;
	place-items: center;
	width: 2.75rem;
	height: 2.75rem;
	border-radius: 0.9rem;
	background: rgba(255, 255, 255, 0.16);
	backdrop-filter: blur(6px);
}

.auth-hero__body {
	position: relative;
	max-width: 26rem;
}

.auth-hero__headline {
	font-size: clamp(1.9rem, 2.6vw, 2.6rem);
	line-height: 1.12;
	font-weight: 700;
	margin: 0 0 1rem;
}

.auth-hero__subtext {
	margin: 0 0 2rem;
	font-size: 1rem;
	line-height: 1.6;
	color: rgba(238, 242, 255, 0.82);
}

.auth-hero__features {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 0.9rem;
}

.auth-hero__features li {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	font-size: 0.95rem;
	color: rgba(238, 242, 255, 0.95);
}

.auth-hero__check {
	display: grid;
	place-items: center;
	width: 1.5rem;
	height: 1.5rem;
	flex-shrink: 0;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.2);
}

.auth-hero__foot {
	position: relative;
	margin: 0;
	font-size: 0.8rem;
	color: rgba(238, 242, 255, 0.65);
}

.auth-hero__foot a {
	color: rgba(255, 255, 255, 0.92);
	font-weight: 600;
	text-decoration: none;
	transition: color 0.15s ease;
}

.auth-hero__foot a:hover {
	color: #fff;
	text-decoration: underline;
}

.auth-panel {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 2rem 1.5rem;
}

.auth-panel__inner {
	width: 100%;
	max-width: 24rem;
}

.auth-panel__brand {
	display: flex;
	align-items: center;
	gap: 0.55rem;
	font-size: 1.15rem;
	font-weight: 700;
	color: #1d4ed8;
	margin-bottom: 2.25rem;
}

@media (min-width: 960px) {
	.auth-panel__brand {
		display: none;
	}
}

.auth-panel__logo {
	display: grid;
	place-items: center;
	width: 2.25rem;
	height: 2.25rem;
	border-radius: 0.7rem;
	color: #fff;
	background: linear-gradient(140deg, #2563eb, #4f46e5);
}

.auth-panel__head {
	margin-bottom: 1.75rem;
}

.auth-panel__head h1 {
	margin: 0 0 0.4rem;
	font-size: 1.7rem;
	font-weight: 700;
	color: #0f172a;
}

.auth-panel__head p {
	margin: 0;
	font-size: 0.92rem;
	line-height: 1.5;
	color: #64748b;
}

.dark .auth-shell {
	background: #0b1220;
}

.dark .auth-panel__head h1 {
	color: #f1f5f9;
}

.dark .auth-panel__head p {
	color: #94a3b8;
}

.dark .auth-panel__brand {
	color: #93c5fd;
}
</style>
