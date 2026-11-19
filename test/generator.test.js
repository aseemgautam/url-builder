const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../public/generator.js');
const config = require('../config.js');

test('inclusive bounds, step 1', () => {
  assert.deepEqual(generate('a[1-3]').urls, ['a1', 'a2', 'a3']);
});

test('zero padding comes from start token', () => {
  assert.deepEqual(generate('x[008-011]').urls, ['x008', 'x009', 'x010', 'x011']);
  assert.deepEqual(generate('x[8-11]').urls, ['x8', 'x9', 'x10', 'x11']);
  assert.deepEqual(generate('x[00-5:5]').urls, ['x00', 'x05']);
});

test('step never exceeds end', () => {
  assert.deepEqual(generate('[0-10:4]').urls, ['0', '4', '8']);
  assert.deepEqual(generate('[0-8:4]').urls, ['0', '4', '8']);
  assert.deepEqual(generate('[5-5:3]').urls, ['5']);
});

test('[000-999:2] gives 500 URLs', () => {
  const { urls, error } = generate('https://myntra.com/6178[000-999:2]');
  assert.equal(error, undefined);
  assert.equal(urls.length, 500);
  assert.equal(urls[0], 'https://myntra.com/6178000');
  assert.equal(urls[1], 'https://myntra.com/6178002');
  assert.equal(urls[499], 'https://myntra.com/6178998');
});

test('multiple brackets: cartesian product, rightmost fastest', () => {
  assert.deepEqual(generate('[1-2]/[0-1]').urls, ['1/0', '1/1', '2/0', '2/1']);
  assert.deepEqual(generate('[1-2]-[1-2]-[1-2]').urls.slice(0, 3), ['1-1-1', '1-1-2', '1-2-1']);
});

test('no brackets returns the pattern as a single URL', () => {
  assert.deepEqual(generate('https://example.com').urls, ['https://example.com']);
});

test('errors: start > end', () => {
  assert.match(generate('[5-1]').error, /start is greater than end/);
});

test('errors: step 0 or negative', () => {
  assert.match(generate('[1-5:0]').error, /step/);
  assert.match(generate('[1-5:-2]').error, /step/);
});

test('errors: non-numeric tokens (including letter ranges)', () => {
  assert.ok(generate('[a-z]').error);
  assert.ok(generate('[1-x]').error);
  assert.ok(generate('[1-5:x]').error);
  assert.ok(generate('[]').error);
  assert.ok(generate('[1-2-3]').error);
});

test('errors: unclosed bracket', () => {
  assert.match(generate('abc[1-5').error, /Unclosed/);
});

test('errors: empty pattern', () => {
  assert.ok(generate('').error);
  assert.ok(generate('   ').error);
});

test('1000 cap: exactly 1000 ok, 1001 errors, never throws', () => {
  assert.equal(generate('[0-999]').urls.length, 1000);
  const over = generate('[0-1000]');
  assert.deepEqual(over.urls, []);
  assert.match(over.error, /Too many URLs/);
  assert.match(generate('[0-99][0-99]').error, /Too many URLs/);
  assert.equal(generate('[0-99999999999]').urls.length, 0);
});

test('custom max option, and default matches config.MAX_URLS', () => {
  assert.match(generate('[1-10]', { max: 5 }).error, /Too many URLs/);
  assert.equal(generate('[1-5]', { max: 5 }).urls.length, 5);
  assert.equal(config.MAX_URLS, 1000);
  assert.ok(generate(`[1-${config.MAX_URLS + 1}]`).error);
});
