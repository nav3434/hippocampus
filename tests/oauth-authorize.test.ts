import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), `hippo-test-oauth-authorize-${Date.now()}.db`);
const PASSWORD = 'correct-horse-battery-staple';

// Env must be set before importing config/oauth modules (eager load)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-oauth-authorize';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_OAUTH_ISSUER = 'https://test.local';
process.env.HIPPO_OAUTH_USER = 'test';
process.env.HIPPO_OAUTH_PASSWORD_HASH = createHash('sha256').update(PASSWORD).digest('base64url');

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { createOAuthRoutes } = await import('../src/auth/oauth.js');

const SAFE_REDIRECT = 'https://client.example/cb';
// `/register` accepts any string as a redirect URI, so this is registrable.
const HOSTILE_REDIRECT = 'https://client.example/cb"><script>alert("redirect")</script>';
const HOSTILE_STATE = '"><script>alert("state")</script>';
const HOSTILE_CHALLENGE = "'><img src=x onerror=alert(1)>";

// The browser decodes entities in an attribute value before submitting the
// form, so an escaped value must come back byte-identical — escaping may not
// corrupt a legitimate `state` that happens to contain & or a quote.
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function hiddenValue(page: string, name: string): string {
  const m = page.match(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`));
  assert.ok(m, `hidden input ${name} not found as a single well-formed attribute`);
  return decodeEntities(m[1]);
}

describe('/authorize', () => {
  let oauth: ReturnType<typeof createOAuthRoutes>;
  let clientId: string;

  before(async () => {
    initDatabase();
    oauth = createOAuthRoutes();
    const res = await oauth.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [SAFE_REDIRECT, HOSTILE_REDIRECT] }),
    });
    assert.equal(res.status, 201);
    clientId = ((await res.json()) as { client_id: string }).client_id;
  });

  after(() => {
    closeDatabase();
  });

  function authorizeUrl(redirectUri: string, state: string, challenge: string): string {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `/authorize?${q}`;
  }

  function post(fields: Record<string, string>) {
    return oauth.request('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  test('GET escapes every reflected parameter on the login form', async () => {
    const res = await oauth.request(authorizeUrl(HOSTILE_REDIRECT, HOSTILE_STATE, HOSTILE_CHALLENGE));
    assert.equal(res.status, 200);
    const page = await res.text();

    // The page has no scripts of its own, so any tag here was injected.
    assert.equal(page.includes('<script'), false, 'a <script> tag was reflected into the page');
    assert.equal(page.includes('<img'), false, 'an <img> tag was reflected into the page');
    assert.ok(page.includes('&lt;script&gt;'), 'the payload should be present, escaped');

    // Each value stays inside its own attribute and round-trips to the original.
    assert.equal(hiddenValue(page, 'redirect_uri'), HOSTILE_REDIRECT);
    assert.equal(hiddenValue(page, 'state'), HOSTILE_STATE);
    assert.equal(hiddenValue(page, 'code_challenge'), HOSTILE_CHALLENGE);
    assert.equal(hiddenValue(page, 'client_id'), clientId);
  });

  test('GET with no state renders an empty state field', async () => {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: SAFE_REDIRECT,
      code_challenge: 'abc',
      code_challenge_method: 'S256',
    });
    const page = await (await oauth.request(`/authorize?${q}`)).text();
    assert.equal(hiddenValue(page, 'state'), '');
  });

  test('POST with valid credentials and a registered redirect_uri issues a code (control)', async () => {
    const res = await post({
      client_id: clientId,
      redirect_uri: SAFE_REDIRECT,
      code_challenge: 'abc',
      state: 'a&b"c',
      username: 'test',
      password: PASSWORD,
    });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, SAFE_REDIRECT);
    assert.ok(location.searchParams.get('code'));
    assert.equal(location.searchParams.get('state'), 'a&b"c');
  });

  test('a hostile-but-registered redirect_uri round-trips from the rendered form into an issued code', async () => {
    // What a browser does: render the form, decode the hidden fields, post them.
    // The POST re-check must still match the registered string exactly.
    const page = await (await oauth.request(authorizeUrl(HOSTILE_REDIRECT, HOSTILE_STATE, HOSTILE_CHALLENGE))).text();
    const res = await post({
      client_id: hiddenValue(page, 'client_id'),
      redirect_uri: hiddenValue(page, 'redirect_uri'),
      code_challenge: hiddenValue(page, 'code_challenge'),
      state: hiddenValue(page, 'state'),
      username: 'test',
      password: PASSWORD,
    });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location')!);
    assert.equal(location.href.startsWith(new URL(HOSTILE_REDIRECT).href), true);
    assert.ok(location.searchParams.get('code'));
    assert.equal(location.searchParams.get('state'), HOSTILE_STATE);
  });

  test('POST refuses a redirect_uri the client never registered, even with valid credentials', async () => {
    const res = await post({
      client_id: clientId,
      redirect_uri: 'https://attacker.example/cb',
      code_challenge: 'abc',
      username: 'test',
      password: PASSWORD,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_request');
  });

  test('POST refuses an unknown client_id, even with valid credentials', async () => {
    const res = await post({
      client_id: 'not-a-registered-client',
      redirect_uri: SAFE_REDIRECT,
      code_challenge: 'abc',
      username: 'test',
      password: PASSWORD,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  });

  test('POST refuses a missing client_id, even with valid credentials', async () => {
    const res = await post({
      redirect_uri: SAFE_REDIRECT,
      code_challenge: 'abc',
      username: 'test',
      password: PASSWORD,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  });
});
