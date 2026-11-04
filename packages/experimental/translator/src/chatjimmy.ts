/** Direct ChatJimmy chat-completions protocol with the prompt tuned for its small model. */
import { createHash } from 'node:crypto'
import type { Config } from './index.ts'
import type { AnonymousTranslationSpec } from './types.ts'
import { TranslationError } from './error.ts'

/**
 * Prompt and protocol revision retained in durable translation identities.
 * Bump it whenever the prompt below or the request envelope changes, so cached results from the old wording are not
 * served after a tuning change.
 */
export const CHATJIMMY_REVISION = 'chatjimmy-literal-v2'

/** Naming the script, not just the language, is what keeps this model out of Traditional glyphs. */
const SIMPLIFIED_CHINESE_NAME = 'Simplified Chinese (简体中文)'
const TRADITIONAL_CHINESE_NAME = 'Traditional Chinese (繁體中文)'

/** Natural-language names for the tags the reasoning-translation panel offers. */
const LANGUAGE_NAMES: Record<string, string> = {
  auto: 'the language of the text', en: 'English', zh: SIMPLIFIED_CHINESE_NAME, 'zh-cn': SIMPLIFIED_CHINESE_NAME,
  'zh-sg': SIMPLIFIED_CHINESE_NAME, 'zh-hans': SIMPLIFIED_CHINESE_NAME, 'zh-tw': TRADITIONAL_CHINESE_NAME,
  'zh-hk': TRADITIONAL_CHINESE_NAME, 'zh-mo': TRADITIONAL_CHINESE_NAME, 'zh-hant': TRADITIONAL_CHINESE_NAME,
  ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German', ru: 'Russian', pt: 'Portuguese',
  it: 'Italian', ar: 'Arabic', vi: 'Vietnamese', th: 'Thai', tr: 'Turkish', id: 'Indonesian', pl: 'Polish',
  nl: 'Dutch', sv: 'Swedish', uk: 'Ukrainian', he: 'Hebrew', hi: 'Hindi', ms: 'Malay',
}

/**
 * Name a language for an instruction-following model instead of passing a locale tag.
 * @param tag - resolved source or destination language tag.
 * @returns the language name, or the tag itself when no name is known.
 */
export function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.toLowerCase()] ?? tag
}

/** Fixed system instruction of the tuned prompt; see {@link chatjimmyPrompt}. */
export const CHATJIMMY_SYSTEM = 'You are a translation engine. Output only the translated text, using the requested script. Never write the <<< >>> markers.'

/**
 * Build the tuned prompt for one fragment.
 *
 * @remarks
 * The upstream model is a legacy 8B instruction model: it answers imperative fragments, comments on them, repeats
 * them in English, copies the prompt's own markers into its reply, and drifts between Simplified and Traditional
 * glyphs. Naming the script removes the glyph drift, and the closing `Translation:` cue is what stops it from
 * answering the fragment: 65 of 71 adversarial sentences usable against 53 for the plain one-line instruction the
 * other anonymous routes use, and 37 for a few-shot prefix. Re-measure through tests/chatjimmy-quality.e2e.ts before
 * changing this wording, and bump CHATJIMMY_REVISION so saved results are not reused under new semantics.
 * [Tuning decision](../../../../.agents/notes/implemented/feature/2026-11-04-keyless-small-model-translation-route.md)
 * @param spec - resolved text and language choices.
 * @returns system instruction and user turn carrying the fragment between the markers.
 */
export function chatjimmyPrompt(spec: AnonymousTranslationSpec): { system: string; user: string } {
  return { system: CHATJIMMY_SYSTEM, user: `Translate into ${languageName(spec.targetLanguage)}:\n<<<${spec.text}>>>\nTranslation:` }
}

/**
 * Build the request envelope the upstream endpoint expects.
 * @param spec - resolved text and language choices.
 * @param config - configured model id and decoding fields.
 * @returns JSON body with the tuned prompt and no credential fields.
 */
export function chatjimmyBody(spec: AnonymousTranslationSpec, config: Config): Record<string, unknown> {
  const { system, user } = chatjimmyPrompt(spec)
  return {
    messages: [{ role: 'user', content: user }],
    chatOptions: { selectedModel: config.chatjimmyModel, systemPrompt: system,
      topK: config.chatjimmyTopK, temperature: config.chatjimmyTemperature },
    attachment: null,
  }
}

const STATS = /<\|stats\|>[\s\S]*?(?:<\|\/stats\|>|<\/stats>|$)/u

/**
 * Separate the assistant translation from the upstream telemetry trailer.
 * @param payload - response body text.
 * @returns translation text and the stats object when the trailer carried a JSON object.
 */
function splitStats(payload: string): { text: string; stats: Record<string, unknown> | undefined } {
  const match = STATS.exec(payload)
  if (match === null) return { text: payload.trim(), stats: undefined }
  const trailer = match[0].replace(/^<\|stats\|>/u, '').replace(/(?:<\|\/stats\|>|<\/stats>)$/u, '')
  const text = (payload.slice(0, match.index) + payload.slice(match.index + match[0].length)).trim()
  return { text, stats: asRecord(safeParse(trailer)) }
}

function safeParse(blob: string): unknown {
  try {
    return JSON.parse(blob.trim())
  } catch (_error) {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Marker this model copies from the prompt, or adds as quotation. */
const OPENING = /^(?:<<<|<<|《|「|“|‘|【|〈|["'])/u
const CLOSING = /(?:>>>|>>|》|」|”|’|】|〉|["'])$/u
const WRAPPER_PAIRS: readonly (readonly [string, string])[] =
  [['《', '》'], ['「', '」'], ['“', '”'], ['‘', '’'], ['（', '）'], ['【', '】'], ['(', ')'], ['[', ']']]

/**
 * Remove the wrapper noise this model adds around an otherwise correct translation.
 * @param text - reply text with telemetry already removed.
 * @returns the translation itself, with at most three nested wrapper layers dropped.
 */
function unwrap(text: string): string {
  let out = text.trim().replace(/^(?:译文|翻译|translation)\s*[:：]\s*/iu, '').trim()
  for (let depth = 0; depth < 3; depth += 1) {
    const stripped = out.replace(OPENING, '').replace(CLOSING, '').trim()
    const pair = WRAPPER_PAIRS.find(([opening, closing]) => stripped.startsWith(opening) && stripped.endsWith(closing)
      && stripped.length > opening.length + closing.length)
    const next = pair === undefined ? stripped : stripped.slice(pair[0].length, stripped.length - pair[1].length).trim()
    if (next === out) break
    out = next
  }
  return out
}

/** Languages whose correct reply cannot be plain ASCII text. */
const NATIVE_SCRIPT = /^(?:zh|ja|ko|th|lo|my|km|ar|he|fa|ur|hi|bn|gu|ta|te|si|ru|uk|be|bg|sr|mk|ky|kk|am|ne|pa)/iu
const NON_ASCII = /[^\x00-\x7F]/u
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu
const REPEATED = /(.{8,})\1/u
/** Glyphs that only occur in Traditional Chinese, so a Simplified request never receives them. */
const TRADITIONAL_ONLY = /[個們來說對時國點樣歷關聯數據庫網絡係範號標準實現簡單繼續動態靜區塊讀寫權歸應將專與發變讓經過運從處門費資質則務議週歲]/u
/** A lowercase-initial alphabetic word, so code identifiers and acronyms do not count as prose. */
const WORD = /^[A-Za-z][a-z]{1,}$/u

function invalidReply(why: string): TranslationError {
  return new TranslationError('TRANSLATION_INVALID_RESPONSE', `chatjimmy ${why}`)
}

function words(source: string): number {
  return source.split(/[^A-Za-z]+/u).filter(word => WORD.test(word)).length
}

function folded(text: string): string {
  return text.toLowerCase().replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]/gu, '')
}

/**
 * Refuse the reply shapes this model is known to produce.
 *
 * @remarks
 * A refusal shows the reader the original reasoning, which is what an untranslated or truncated reply already
 * looks like, so the guard loses nothing and keeps leaked prompt text and hallucinations out of the UI.
 * @param spec - resolved fragment and destination language.
 * @param translation - reply after telemetry and wrappers were removed.
 * @throws TranslationError for an untranslated, echoed, truncated, padded, or self-repeating reply.
 */
function guardReply(spec: AnonymousTranslationSpec, translation: string): void {
  const target = spec.targetLanguage.toLowerCase()
  const content = folded(translation), source = folded(spec.text)
  const chineseOrJapanese = /^zh/iu.test(target) || /^ja/iu.test(target)
  const rendered = chineseOrJapanese ? (translation.match(HAN) ?? []).length : 0
  const count = words(spec.text)
  if (NATIVE_SCRIPT.test(target) && !NON_ASCII.test(translation)) throw invalidReply('left the fragment untranslated')
  if (content === source || (source.length > 8 && content.includes(source))) throw invalidReply('repeated the fragment')
  if (REPEATED.test(content)) throw invalidReply('repeated itself')
  if (/^zh(?:-cn|-sg|-hans)?$/u.test(target) && TRADITIONAL_ONLY.test(translation)) throw invalidReply('used the wrong Chinese script')
  if (!chineseOrJapanese || count < 3) return
  if (count >= 5 && rendered < count * 0.5) throw invalidReply('dropped most of the fragment')
  if (rendered > count * 6) throw invalidReply('added text the fragment does not contain')
}

/**
 * Read the translation out of a plain-text upstream body.
 * @param payload - complete response text.
 * @param spec - resolved fragment and destination language, used to refuse an unusable reply.
 * @returns translation with the telemetry trailer and reply wrappers removed.
 * @throws TranslationError `TRANSLATION_INVALID_RESPONSE` when nothing is left, when prompt markers survive, when the
 *   telemetry reports a finish other than `stop`, or when {@link guardReply} refuses the reply shape.
 */
export function chatjimmyTranslation(payload: string, spec: AnonymousTranslationSpec): string {
  const { text, stats } = splitStats(payload)
  const translation = unwrap(text)
  if (translation === '' || /<<<|>>>|<\||stats\|>/u.test(translation)) {
    throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'chatjimmy returned an invalid translation response')
  }
  if (stats?.done_reason !== undefined && stats.done_reason !== 'stop') {
    throw invalidReply('translation was cut short')
  }
  guardReply(spec, translation)
  return translation
}

/**
 * Identify chatjimmy request semantics for durable result reuse.
 * @param config - endpoint, model id and decoding fields; the raw endpoint stays a fingerprint.
 * @returns protocol revision with endpoint, model and decoding tuple.
 */
export function chatjimmyRecipe(config: Config): string {
  const url = new URL(config.chatjimmyEndpoint)
  return JSON.stringify([CHATJIMMY_REVISION, createHash('sha256').update(url.href).digest('hex'),
    config.chatjimmyModel, config.chatjimmyTopK, config.chatjimmyTemperature])
}
