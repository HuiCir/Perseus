export class ModelCapabilityError extends Error {
  constructor(code) {
    super('Speculator model capabilities could not be confirmed');
    this.name = 'ModelCapabilityError'; this.code = code;
  }
}

/** Use the native catalog, never a guessed GPT family table or Actor defaults. */
export async function readSpeculatorProfile(client, { speculatorModel, speculatorEffort }, { signal } = {}) {
  if (typeof speculatorModel !== 'string' || !speculatorModel ||
      (speculatorEffort !== undefined && (typeof speculatorEffort !== 'string' || !speculatorEffort)))
    throw new ModelCapabilityError('INVALID_SPECULATOR_CONFIG');
  const matches = [], seen = new Set(); let cursor;
  do {
    let page;
    try { page = await client.request('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) }, { signal }); }
    catch { throw new ModelCapabilityError(signal?.aborted ? 'MODEL_CATALOG_CANCELLED' : 'MODEL_CATALOG_UNAVAILABLE'); }
    if (!Array.isArray(page?.data)) throw new ModelCapabilityError('INVALID_MODEL_CATALOG');
    matches.push(...page.data.filter(model => model.model === speculatorModel));
    cursor = page.nextCursor;
    if (cursor != null && (typeof cursor !== 'string' || !cursor || seen.has(cursor)))
      throw new ModelCapabilityError('INVALID_MODEL_CATALOG_CURSOR');
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (matches.length !== 1) throw new ModelCapabilityError('SPECULATOR_MODEL_UNAVAILABLE');
  const model = matches[0];
  if (!Array.isArray(model.supportedReasoningEfforts) || !model.supportedReasoningEfforts.length ||
      !model.supportedReasoningEfforts.every(option => typeof option?.reasoningEffort === 'string' && option.reasoningEffort))
    throw new ModelCapabilityError('REASONING_CAPABILITIES_UNAVAILABLE');
  const supported = [...new Set(model.supportedReasoningEfforts.map(option => option.reasoningEffort))];
  const effort = supported.includes(speculatorEffort) ? speculatorEffort : model.defaultReasoningEffort;
  if (!supported.includes(effort)) throw new ModelCapabilityError('REASONING_DEFAULT_UNAVAILABLE');
  const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (speculatorEffort !== undefined && effort !== speculatorEffort &&
      (levels.indexOf(speculatorEffort) < 0 || levels.indexOf(effort) < 0 || levels.indexOf(effort) > levels.indexOf(speculatorEffort)))
    throw new ModelCapabilityError('REASONING_DEFAULT_EXCEEDS_REQUEST');
  if (model.inputModalities !== undefined && (!Array.isArray(model.inputModalities) || !model.inputModalities.includes('text')))
    throw new ModelCapabilityError('SPECULATOR_TEXT_INPUT_UNAVAILABLE');
  return Object.freeze({ model: speculatorModel, effort, requestedEffort: speculatorEffort,
    effortAdjusted: speculatorEffort !== undefined && effort !== speculatorEffort,
    supportedReasoningEfforts: Object.freeze(supported), capabilitySource: 'model/list' });
}

/** Cancellation of one domain must not cancel a shared catalog lookup. */
export async function awaitProfile(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
