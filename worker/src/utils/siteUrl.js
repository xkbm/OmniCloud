// Canonical public URL of the Pages deployment: used for OAuth redirect
// targets, post-auth frontend redirects and the CORS allow-list.
export function getSiteUrl(env) {
	return env.FRONTEND_URL || env.CORS_ORIGIN || 'http://localhost:5173';
}
