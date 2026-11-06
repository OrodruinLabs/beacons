import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainStringEnd } from '../../src/engine/json-string-skip.js';
import { AdvisorModelFinder, TopLevelFieldFinder, parseAdvisorModel, parseRequestModel } from '../../src/engine/model.js';
import * as ref from './fixtures/model.reference.js';

test('plainStringEnd finds the unescaped closing quote and reports how a chunk ends inside a string', () => {
  assert.equal(plainStringEnd(Buffer.from('abc"rest'), 0), 3);
  assert.equal(plainStringEnd(Buffer.from('a\\"b"'), 0), 4);
  assert.equal(plainStringEnd(Buffer.from('a\\\\"b'), 0), 3);
  assert.equal(plainStringEnd(Buffer.from('no quote'), 0), -1);
  assert.equal(plainStringEnd(Buffer.from('ends escaped\\'), 0), -2);
  assert.equal(plainStringEnd(Buffer.from('ends even\\\\'), 0), -1);
  assert.equal(plainStringEnd(Buffer.from('xx\\"'), 3), 3);
});

let seed = 11;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const noise = () => Array.from({ length: 150 }, () => ['a', '\\', '"', '\n', 'é', 'advisor', '"model":"x"', '{"type":"advisor_1"}'][rand(8)]).join('');

const bodies = () => Array.from({ length: 40 }, (_, round) => Buffer.from(JSON.stringify({
  model: round % 3 ? `claude-${noise().slice(0, 12)}` : 'claude-opus-5-5',
  system: [{ type: 'text', text: noise() }],
  messages: [{ role: 'user', content: noise() }, { tools: [{ type: 'advisor_decoy', model: 'decoy' }], metadata: { user_id: 'decoy' } }],
  tools: [{ name: 'Bash', input_schema: { model: noise() } }, ...(round % 2 ? [{ type: 'advisor_20260301', name: 'advisor', model: `adv-${round}` }] : [])],
})));

test('the advisor and top-level finders match the original byte walk on escape-heavy bodies, whole and chunked', () => {
  for (const body of bodies()) {
    assert.equal(parseAdvisorModel(body), ref.parseAdvisorModel(body));
    assert.equal(parseRequestModel(body), ref.parseRequestModel(body));
    for (const [Finder, RefFinder, arg] of [[AdvisorModelFinder, ref.AdvisorModelFinder], [TopLevelFieldFinder, ref.TopLevelFieldFinder, 'model']]) {
      const a = new Finder(arg);
      const b = new RefFinder(arg);
      let got = null;
      let want = null;
      for (let i = 0; i < body.length;) { const n = 1 + rand(200); got = a.push(body.subarray(i, i + n)); want = b.push(body.subarray(i, i + n)); i += n; }
      assert.equal(got, want);
    }
  }
});
