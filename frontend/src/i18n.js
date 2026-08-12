import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import es from './locales/es.json';

const SUPPORTED_LOCALES = ['es', 'en'];
const DEFAULT_LOCALE = 'es';

function detectLocale() {
	const stored = window.localStorage.getItem('omnicloud-language');
	if (stored === 'id') {
		window.localStorage.setItem('omnicloud-language', 'es');
		return 'es';
	}
	if (stored && SUPPORTED_LOCALES.includes(stored)) {
		return stored;
	}

	const browserLang = navigator.language.split('-')[0];
	if (browserLang === 'id') {
		return 'es';
	}
	if (SUPPORTED_LOCALES.includes(browserLang)) {
		return browserLang;
	}

	return DEFAULT_LOCALE;
}

export const i18n = createI18n({
	legacy: false,
	locale: detectLocale(),
	fallbackLocale: 'en',
	messages: {
		en,
		es,
	},
});

export function setLocale(locale) {
	if (SUPPORTED_LOCALES.includes(locale)) {
		i18n.global.locale.value = locale;
		window.localStorage.setItem('omnicloud-language', locale);
		document.documentElement.setAttribute('lang', locale);
	}
}

export function getLocale() {
	return i18n.global.locale.value;
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };
