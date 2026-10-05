import vendor from '../lib/schema-validator.cjs';
import { canonicalJSON } from './cache.mjs';

const validators = new Map();
/** Full JSON Schema validation; unsupported drafts/keywords/references fail closed. */
export function validateJsonSchema(schema, value) {
  const key = canonicalJSON(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = vendor.compileSchema(structuredClone(schema));
    validators.set(key, validate);
  }
  return validate(value);
}
