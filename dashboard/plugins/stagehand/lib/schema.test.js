'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeSchema, schemaToZod } = require('./schema');

test('normalizeSchema accepts shorthand objects', () => {
  const normalized = normalizeSchema({ price: 'number', currency: 'string' });
  assert.deepEqual(normalized, {
    type: 'object',
    properties: {
      price: { type: 'number' },
      currency: { type: 'string' },
    },
  });
});

test('schemaToZod builds nested validators', () => {
  const schema = normalizeSchema({
    type: 'object',
    properties: {
      product: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'number', minimum: 1 },
        },
      },
      links: {
        type: 'array',
        items: { type: 'string', format: 'url' },
      },
    },
  });
  const parsed = schemaToZod(schema).parse({
    product: { name: 'Chair', price: 12 },
    links: ['https://example.com/item'],
  });
  assert.equal(parsed.product.name, 'Chair');
  assert.equal(parsed.links[0], 'https://example.com/item');
});
