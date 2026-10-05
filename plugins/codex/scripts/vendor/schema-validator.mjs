import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export function compileSchema(schema) {
  const draft = schema?.$schema;
  const Constructor = !draft || /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(draft) ? Ajv
    : /^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(draft) ? Ajv2019
    : /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(draft) ? Ajv2020 : undefined;
  if (!Constructor) throw new TypeError('Unsupported JSON Schema draft');
  const ajv = new Constructor({ strictSchema: true, strictTypes: false, strictTuples: false,
    allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false,
    validateFormats: true, ownProperties: true, $data: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate.$async) throw new TypeError('Asynchronous schemas are unsupported');
  return validate;
}
