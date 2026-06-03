/**
 * Query-focused fact extraction.
 *
 * Distills a long raw event payload into a set of atomic, standalone facts so
 * that focused reads (`read_knowledge({ focused: true })`) can serve compact,
 * specific evidence instead of the full conversation. The derived facts are an
 * internal index — they are written back as `semantic_type='extracted_fact'`
 * events (see trigger-fact-extraction.ts) and never surface as first-class
 * content on normal reads.
 *
 * The LLM call is opt-in: without `FACT_EXTRACTOR_API_KEY` configured the
 * extractor returns `[]`, so the feature degrades gracefully (focused reads
 * fall back to raw payload_text and the builder is a no-op).
 */

import { createHash } from 'node:crypto';
import type { Env } from '../index';
import logger from './logger';

/**
 * The proven extraction prompt, ported verbatim from the validated benchmark
 * adapter. It recovers knowledge-update + multi-session accuracy by forcing
 * verbatim specifics and one-fact-per-item decomposition. The hash of this
 * string is the prompt half of the extractor-version stamp — editing the text
 * MUST change the stamp so previously-extracted events get re-extracted.
 */
export const FACT_EXTRACTION_PROMPT =
  'Extract a COMPLETE, FAITHFUL set of atomic facts from the conversation below. ' +
  'PRESERVE ALL SPECIFICS VERBATIM: numbers, counts, dates, names, prices, durations, locations. ' +
  'When the user has MULTIPLE of something (multiple pets, trips, purchases, devices), emit ONE fact PER ITEM; ' +
  'never collapse a collection into a summary. ' +
  'Each fact is a standalone declarative sentence understandable without the conversation. ' +
  'Output one fact per line, no numbering, no preamble.';

/** Short, stable hash of the prompt — used in the extractor-version stamp. */
export const FACT_EXTRACTION_PROMPT_HASH = createHash('sha256')
  .update(FACT_EXTRACTION_PROMPT)
  .digest('hex')
  .slice(0, 8);

/**
 * Resolve the extractor model name from env, defaulting to a small Haiku.
 * Exported so the builder can compose the version stamp from the same source.
 */
export function factExtractorModel(env: Env): string {
  return env.FACT_EXTRACTOR_MODEL || 'claude-haiku-4-5';
}

/**
 * The stable extractor-version stamp: `<model>+<prompt-hash>`. Persisted on
 * each derived fact's metadata so the builder's NOT EXISTS guard can detect
 * events that were extracted under an older model/prompt and re-extract them.
 */
export function factExtractorVersion(env: Env): string {
  return `fact-extract-v1:${factExtractorModel(env)}+${FACT_EXTRACTION_PROMPT_HASH}`;
}

/** Cap on payload size handed to the model — controls cost and latency. */
const MAX_INPUT_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Extract atomic facts from `text` via an OpenAI-compatible chat completion.
 *
 * Returns `[]` (no facts) when:
 *  - no `FACT_EXTRACTOR_API_KEY` is configured (feature is opt-in), or
 *  - the request fails / times out / returns no parseable lines.
 *
 * Callers treat `[]` as "nothing to derive" — the focused read path then
 * falls back to raw `payload_text`.
 */
export async function extractFacts(text: string, env: Env): Promise<string[]> {
  const apiKey = env.FACT_EXTRACTOR_API_KEY;
  if (!apiKey) return [];

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;

  const baseUrl = (env.FACT_EXTRACTOR_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = factExtractorModel(env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: FACT_EXTRACTION_PROMPT },
          { role: 'user', content: input },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, detail: detail.slice(0, 200) },
        '[fact-extractor] chat completion request failed'
      );
      return [];
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseFactLines(content);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[fact-extractor] extraction failed; returning no facts'
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the model's line-per-fact output into clean fact strings. Drops empty
 * lines, list numbering / bullet prefixes the model may add despite the prompt,
 * and any obvious preamble line ("Here are the facts:").
 */
export function parseFactLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) =>
      line
        // strip leading bullet / numbering markers: "- ", "* ", "1. ", "2) "
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
        .trim()
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:here (?:are|is)\b|facts?:|the facts?\b)/i.test(line));
}
