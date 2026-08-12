const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL
	|| (typeof window !== 'undefined'
		? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/uploads`
		: 'ws://localhost:8787/ws/uploads');

async function request(path, options = {}) {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {}),
		},
		...options,
	});

	if (!response.ok) {
		const payload = await response.json().catch(() => ({ error: 'Unknown API error' }));
		const error = new Error(payload.error || 'API request failed');
		error.status = response.status;
		throw error;
	}

	return response.json();
}

export { API_BASE_URL, WS_BASE_URL };

export const authApi = {
	me() {
		return request('/auth/me');
	},
	login(payload) {
		return request('/auth/login', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	logout() {
		return request('/auth/logout', {
			method: 'POST',
		});
	},
};
