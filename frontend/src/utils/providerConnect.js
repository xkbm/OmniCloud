import { api } from '../services/api';

// OAuth providers that can be reconnected via a full-page redirect.
// QuotaView keeps its own copy of this flow (deliberately not refactored to
// avoid regressions); this util exists so error surfaces (e.g. the upload
// toast) can trigger the same reconnection with one click.
const OAUTH_CONNECT = {
	google_drive: () => api.getGoogleConnectUrl(),
	onedrive: () => api.getOneDriveConnectUrl(),
	dropbox: () => api.getDropboxConnectUrl(),
	yandex: () => api.getYandexConnectUrl(),
};

export function isOAuthProvider(provider) {
	return Boolean(OAUTH_CONNECT[provider]);
}

export async function connectOAuthProvider(provider) {
	const getConnectUrl = OAUTH_CONNECT[provider];
	if (!getConnectUrl) return false;
	const { data } = await getConnectUrl();
	if (!data?.authorizationUrl) return false;
	window.location.href = data.authorizationUrl;
	return true;
}
