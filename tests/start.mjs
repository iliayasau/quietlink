import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const go = process.env.GO_BIN || 'go';
mkdirSync('bin', { recursive: true });
const extension = process.platform === 'win32' ? '.exe' : '';
for (const name of ['devissuer', 'quietlink']) {
  const build = spawnSync(go, ['build', '-o', `bin/${name}${extension}`, `./cmd/${name}`], { stdio: 'inherit' });
  if (build.error || build.status !== 0) { console.error('Go build failed. Install Go and set GO_BIN if it is not on PATH.'); process.exit(1); }
}
const env = { ...process.env, APP_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:8080', OIDC_ISSUER: 'http://127.0.0.1:9090', OIDC_CLIENT_ID: 'quietlink-local', OIDC_CLIENT_SECRET: '', LISTEN_ADDR: '127.0.0.1:8080', ICE_SERVERS: '[]' };
const children = [];
const start = name => { const child = spawn(`bin/${name}${extension}`, [], { env, stdio: 'inherit' }); children.push(child); child.on('error', () => process.exit(1)); return child; };
function stop() { for (const child of children) child.kill(); }
process.on('exit', stop);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
start('devissuer');
let ready = false;
for (let n = 0; n < 50; n++) { try { const response = await fetch(`${env.OIDC_ISSUER}/.well-known/openid-configuration`); if (response.ok) { ready = true; break; } } catch { /* Retry while the fixture starts. */ } await new Promise(resolve => setTimeout(resolve, 100)); }
if (!ready) process.exit(1);
start('quietlink');
