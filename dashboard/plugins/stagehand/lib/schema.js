'use strict';

const { z } = require('zod');

const KNOWN_KEYS = new Set(['type', 'properties', 'items', 'enum', 'format', 'required', 'minimum', 'maximum', 'description']);

function _isSchemaLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => KNOWN_KEYS.has(key));
}

function normalizeSchema(value) {
  if (typeof value === 'string') {
    return { type: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('schema must be an object');
  }
  if (_isSchemaLike(value)) {
    const out = { ...value };
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
      const props = {};
      for (const [key, child] of Object.entries(out.properties)) props[key] = normalizeSchema(child);
      out.properties = props;
    }
    if (out.items) out.items = normalizeSchema(out.items);
    return out;
  }
  const properties = {};
  for (const [key, child] of Object.entries(value)) properties[key] = normalizeSchema(child);
  return { type: 'object', properties };
}

function schemaToZod(schema) {
  switch (schema.type) {
    case 'object': {
      const shape = {};
      if (schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          shape[key] = schemaToZod(value);
        }
      }
      let zodObject = z.object(shape);
      if (schema.required && Array.isArray(schema.required)) {
        const requiredFields = schema.required.reduce((acc, field) => {
          acc[field] = true;
          return acc;
        }, {});
        zodObject = zodObject.partial().required(requiredFields);
      }
      if (schema.description) zodObject = zodObject.describe(schema.description);
      return zodObject;
    }
    case 'array': {
      let zodArray = z.array(schema.items ? schemaToZod(schema.items) : z.any());
      if (schema.description) zodArray = zodArray.describe(schema.description);
      return zodArray;
    }
    case 'string': {
      if (schema.enum && schema.enum.length) return z.string().refine((val) => schema.enum.includes(val));
      let zodString = z.string();
      if (schema.format === 'uri' || schema.format === 'url') zodString = zodString.url();
      else if (schema.format === 'email') zodString = zodString.email();
      else if (schema.format === 'uuid') zodString = zodString.uuid();
      if (schema.description) zodString = zodString.describe(schema.description);
      return zodString;
    }
    case 'number':
    case 'integer': {
      let zodNumber = z.number();
      if (schema.minimum !== undefined) zodNumber = zodNumber.min(schema.minimum);
      if (schema.maximum !== undefined) zodNumber = zodNumber.max(schema.maximum);
      if (schema.description) zodNumber = zodNumber.describe(schema.description);
      return zodNumber;
    }
    case 'boolean': {
      let zodBoolean = z.boolean();
      if (schema.description) zodBoolean = zodBoolean.describe(schema.description);
      return zodBoolean;
    }
    case 'null':
      return z.null();
    default:
      return z.any();
  }
}

module.exports = { normalizeSchema, schemaToZod };
