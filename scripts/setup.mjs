#!/usr/bin/env node
// OmniCloud interactive bootstrap for self-hosting on Cloudflare + Neon.
//
//   node scripts/setup.mjs                       # interactive
//   node scripts/setup.mjs --name mycloud --url postgres://... [--yes]
//
// What it does:
//   1. Generates ENCRYPTION_KEY / AUTH_SECRET locally (never leave your machine)
//   2. Patches worker/wrangler.toml + pages/wrangler.toml with your project name
//   3. Applies the database schema (idempotent)
//   4. Writes worker/.dev.vars and prints the exact next steps to deploy

import { execSync, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workerDir = path.join(repoRoot, 'worker');
const pagesDir = path.join(repoRoot, 'pages');

const args = process.argv.slice(2);
function flag(name) {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? null : (args[index + 1] ?? '');
}
const nonInteractive = args.includes('--yes');

async function ask(rl, question, fallback = '') {
	if (nonInteractive && fallback !== undefined) return fallback;
	const answer = (await rl.question(question)).trim();
	return answer || fallback;
}

function patchFile(filePath, replacements) {
	let content = fs.readFileSync(filePath, 'utf8');
	for (const [pattern, replacement] of replacements) {
		if (!new RegExp(pattern).test(content)) {
			console.error(`✖ Pattern not found in ${filePath}: ${pattern}`);
			process.exit(1);
		}
		content = content.replace(new RegExp(pattern, 'g'), replacement);
	}
	fs.writeFileSync(filePath, content);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('🚀 OmniCloud self-hosting setup\n');

const dbName = await ask(rl, 'Project base name (used for Worker + Pages): ', 'omnicloud');
const databaseUrl = await ask(rl, 'Neon/Postgres DATABASE_URL: ', flag('url') || '');

if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
	console.error('\n✖ DATABASE_URL must be a postgres:// connection string (Neon free tier works).');
	process.exit(1);
}

// 1. Secrets generated locally — never transmitted anywhere except your own DB/CF.
const encryptionKey = randomBytes(32).toString('base64url');
const authSecret = createHash('sha256').update(`omnicloud-auth-v1:${encryptionKey}`).digest('hex');
console.log('\n🔐 Generated ENCRYPTION_KEY + AUTH_SECRET locally.\n');

// 2. Patch wrangler configs so every name stays consistent.
patchFile(path.join(workerDir, 'wrangler.toml'), [
	['name = "[^"]*"', `name = "${dbName}-api"`],
	['FRONTEND_URL = "[^"]*"',
		`FRONTEND_URL = ""  # set after first deploy: https://<project>.pages.dev`],
]);
patchFile(path.join(pagesDir, 'wrangler.toml'), [
	['name = "[^"]*"', `name = "${dbName}"`],
	['service = "[^"]*"', `service = "${dbName}-api"`],
]);
console.log('📝 Patched worker/wrangler.toml and pages/wrangler.toml\n');

// 3. .dev.vars for local dev & reference.
fs.writeFileSync(
	path.join(workerDir, '.dev.vars'),
	[
		`DATABASE_URL=${databaseUrl}`,
		`ENCRYPTION_KEY=${encryptionKey}`,
		`AUTH_SECRET=${authSecret}`,
		'GOOGLE_CLIENT_ID=',
		'GOOGLE_CLIENT_SECRET=',
		'GOOGLE_REDIRECT_URI=',
		'GEMINI_API_KEY=',
	].join('\n') + '\n',
);
console.log('📝 Wrote worker/.dev.vars (git-ignored)\n');

// 4. Apply schema + migrations.
if (!nonInteractive && !(await ask(rl, 'Apply database schema now? [Y/n] ', 'Y')).match(/^n/i)) {
	console.log('\n🗄  Applying schema...');
	const result = spawnSync(process.execPath, [path.join(workerDir, 'scripts', 'db-apply.mjs'), databaseUrl], {
		stdio: 'inherit',
		env: { ...process.env },
	});
	if (result.status !== 0) {
		console.error('\n✖ Database apply failed — fix the error above and re-run this script.');
		process.exit(1);
	}
}

rl.close();

// 5. Next steps.
const workerName = `${dbName}-api`;
console.log(`
✅ Setup complete. Next steps:

1) Deploy the API worker:
     cd worker && npx wrangler deploy

2) Create the frontend project in the Cloudflare dashboard (Workers & Pages → Create → Pages → Connect to Git):
     Build command:      pnpm --filter frontend build
     Output directory:   frontend/dist
     Root directory:     (repo root)
   Or CLI: cd frontend && pnpm build && npx wrangler pages project create ${dbName} + pages deploy dist

3) Wire the Pages→Worker binding (pages/wrangler.toml already points service="${workerName}").

4) Google Drive login (optional, do AFTER step 1 so you know your URLs):
   - console.cloud.google.com → create OAuth client (Web application)
   - Authorized redirect URI: https://${workerName}.<your-subdomain>.workers.dev/api/accounts/google/callback
     (or your custom domain equivalent)
   - Set as Cloudflare secrets:
       cd worker
       npx wrangler secret put GOOGLE_CLIENT_ID
       npx wrangler secret put GOOGLE_CLIENT_SECRET
       npx wrangler secret put GOOGLE_REDIRECT_URI
   - Also set var FRONTEND_URL in wrangler.toml to your final site URL.

5) Optional AI assistant: npx wrangler secret put GEMINI_API_KEY

6) Set FRONTEND_URL in worker/wrangler.toml once you know the final URL, then redeploy.

Docs & troubleshooting: SELF-HOSTING.md
`);
