import { Router } from 'express';
import { env } from '../config/env.js';
import {
	createSession,
	destroySession,
	getAuthSummary,
	loginHostedUser,
} from '../services/authService.js';

const router = Router();

function setAuthCookie(res, token) {
	const options = res.locals.authCookieOptions || {};
	res.cookie(env.authCookieName, token, options);
}

function clearAuthCookie(res) {
	const options = res.locals.authCookieOptions || {};
	res.clearCookie(env.authCookieName, { ...options, maxAge: 0 });
}

router.get('/auth/me', (req, res) => {
	res.json({ data: getAuthSummary(req.user) });
});

// Public registration is intentionally disabled. Account creation must be
// performed out-of-band by the administrator.

router.post('/auth/login', (req, res, next) => {
	try {
		const user = loginHostedUser(req.body || {});
		const session = createSession(user.id);
		setAuthCookie(res, session.token);
		res.json({ data: getAuthSummary(user) });
	} catch (error) {
		next(error);
	}
});

router.post('/auth/logout', (req, res) => {
	const cookieHeader = req.headers.cookie || '';
	const token = cookieHeader
		.split(';')
		.map((item) => item.trim())
		.find((item) => item.startsWith(`${env.authCookieName}=`))
		?.slice(env.authCookieName.length + 1);

	if (token) {
		destroySession(decodeURIComponent(token));
	}

	clearAuthCookie(res);
	res.json({ data: getAuthSummary(env.appMode === 'local' ? req.user : null) });
});

export default router;
