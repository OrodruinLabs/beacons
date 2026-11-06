import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedHost, upstreamFetch, proxyFetch } from '../../src/engine/upstream-fetch.js';

for (const url of [
  'https://api.anthropic.com/v1/messages',
  'https://platform.claude.com/v1/oauth/token',
  'http://127.0.0.1:8787/w/claude/v1/messages',
  'http://localhost:4747/v1/messages',
  'https://does-not-exist.invalid/v1/messages',
  'http://198.51.100.7:3128',
]) {
  test(`allowlist lets ${new URL(url).hostname} through`, () => {
    assert.doesNotThrow(() => assertAllowedHost(url));
  });
}

for (const url of [
  'https://api.sx.org/v1/proxy',
  'https://api.ipify.org',
  'https://registry.npmjs.org/cc-gateway',
  'https://api.deepseek.com/anthropic/v1/messages',
  'https://github.com',
  'https://claude.ai.evil.example/v1/messages',
  'https://8.8.8.8/',
]) {
  test(`allowlist refuses ${new URL(url).hostname}`, () => {
    assert.throws(() => assertAllowedHost(url), /not on the local allowlist/);
  });
}

test('upstreamFetch refuses a host off the allowlist before any socket opens', () => {
  assert.throws(() => upstreamFetch('https://api.deepseek.com/v1/messages', { method: 'POST' }), /refused/);
});

test('proxyFetch refuses a host off the allowlist before any socket opens', () => {
  assert.throws(() => proxyFetch('https://api.sx.org/v1/status'), /refused/);
});
