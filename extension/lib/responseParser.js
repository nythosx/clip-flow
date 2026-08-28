// Parses AI chat responses for ClipFlow's 3 fixed functions. Smart Trimmer and Clip
// Finder expect a JSON array; Caption Generator expects a plain string. Replaces
// toolCalls.js's coding-agent-specific !TOOL/[SUBTASK]/DONE parsing, which ClipFlow has no
// use for.

const ResponseParser = (() => {
  // Models routinely wrap JSON in a fenced code block despite being asked not to.
  function stripCodeFence(text) {
    const trimmed = (text || '').trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
  }

  // Throws if `text` isn't a JSON array (or isn't valid JSON at all).
  function parseJsonArray(text) {
    const cleaned = stripCodeFence(text);
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected a JSON array response');
    }
    return parsed;
  }

  function looksLikeValidJsonArray(text) {
    try {
      parseJsonArray(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Throws if `text` isn't a JSON object (array/null/primitive all rejected) or isn't
  // valid JSON at all. Used by Caption Generator, whose response is a single
  // `{caption, hashtags}` object rather than a list.
  function parseJsonObject(text) {
    const cleaned = stripCodeFence(text);
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object response');
    }
    return parsed;
  }

  return { stripCodeFence, parseJsonArray, parseJsonObject, looksLikeValidJsonArray };
})();
