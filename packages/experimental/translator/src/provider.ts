/** Anonymous provider protocols, bounded JSON intake and normalized Chinese language tags. */
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Config } from './index.ts'
import type { AnonymousTranslationProvider, AnonymousTranslationSpec, TranslationProvider } from './types.ts'
import { TranslationError } from './error.ts'
import { createHash } from 'node:crypto'

/** Anonymous endpoint choices, in the order the preferences list presents them. */
export const ANONYMOUS_PROVIDERS = ['bing', 'google', 'deeplx'] as const satisfies readonly AnonymousTranslationProvider[]

/**
 * Whether the route reaches a deployment-configured endpoint with no credential the Host manages.
 * @param provider - explicitly resolved route.
 * @returns true when the route uses an anonymous endpoint protocol and its request bounds.
 */
export function isAnonymousProvider(provider: TranslationProvider): provider is AnonymousTranslationProvider {
  return provider === 'google' || provider === 'bing' || provider === 'deeplx'
}

/** Request-revision tag retained in durable translation identities per endpoint protocol. */
const ANONYMOUS_REVISIONS: Record<AnonymousTranslationProvider, string> = {
  google: 'google-form-v1', bing: 'bing-edge-v1', deeplx: 'deeplx-json-v1',
}

/** Query parameters the protocol sets per request, so they never enter the endpoint fingerprint. */
const ANONYMOUS_OWNED_PARAMS: Record<AnonymousTranslationProvider, readonly string[]> = {
  google: ['client', 'sl', 'tl', 'dt', 'q'], bing: ['from', 'to', 'isEnterpriseClient'],
  deeplx: ['text', 'source_lang', 'target_lang', 'authKey', 'auth_key'],
}

/**
 * Accept only an HTTP(S) endpoint carrying no credentials or fragment.
 * @param value - configured endpoint.
 * @returns the normalized endpoint URL.
 */
export function endpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('Translation endpoint must be an HTTP(S) URL without credentials or a fragment')
  }
  return url.href
}

function anonymousEndpoint(provider: AnonymousTranslationProvider, config: Config): string {
  switch (provider) {
    case 'google': return config.googleEndpoint
    case 'bing': return config.bingEndpoint
    // Read per request: the reasoning-translation panel can retarget DeepLX while the service stays mounted.
    case 'deeplx': return config.deeplxEndpoint.get()
    /* v8 ignore next -- AnonymousTranslationProvider is a closed union resolved by Config validation. */
    default: return assertNever(provider)
  }
}

/**
 * Resolve the configured endpoint for one anonymous route.
 *
 * A live field has no load-time check to lean on, so an unusable address is rejected when a request reads it.
 * The address never enters the diagnostic: it can carry the instance key as a query parameter.
 * @param provider - anonymous route selected for this request.
 * @param config - deployment and panel-configured endpoints.
 * @returns the endpoint URL to send the request to.
 * @throws TranslationError with `TRANSLATION_ENDPOINT_INVALID` for a value that is not an HTTP(S) URL
 * without credentials or a fragment.
 */
function endpointUrl(provider: AnonymousTranslationProvider, config: Config): URL {
  try {
    return new URL(endpoint(anonymousEndpoint(provider, config)))
  } catch (_error) {
    throw new TranslationError('TRANSLATION_ENDPOINT_INVALID', `${provider} translation endpoint is not a usable HTTP(S) URL`)
  }
}

/**
 * Identify anonymous request semantics without provider-specific language normalization.
 * @param provider - explicitly resolved endpoint route.
 * @param config - deployment endpoints; raw endpoint values are excluded from stored recipes.
 * @returns protocol revision and effective endpoint fingerprint for durable result reuse.
 */
export function anonymousRecipe(provider: AnonymousTranslationProvider, config: Config): string {
  const url = endpointUrl(provider, config)
  for (const key of ANONYMOUS_OWNED_PARAMS[provider]) url.searchParams.delete(key)
  return JSON.stringify([ANONYMOUS_REVISIONS[provider], createHash('sha256').update(url.href).digest('hex')])
}

const SIMPLIFIED_CHINESE = ['zh', 'zh-cn', 'zh-sg', 'zh-hans']
const TRADITIONAL_CHINESE = ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']

function language(tag: string, provider: AnonymousTranslationProvider): string {
  const lower = tag.toLowerCase()
  if (provider === 'deeplx') {
    if (lower === 'auto') return 'auto'
    if (SIMPLIFIED_CHINESE.includes(lower)) return 'ZH-HANS'
    if (TRADITIONAL_CHINESE.includes(lower)) return 'ZH-HANT'
    return lower.split(/[-_]/).map(part => part.toUpperCase()).join('-')
  }
  if (SIMPLIFIED_CHINESE.includes(lower)) return provider === 'google' ? 'zh-CN' : 'zh-Hans'
  if (TRADITIONAL_CHINESE.includes(lower)) return provider === 'google' ? 'zh-TW' : 'zh-Hant'
  return tag
}

function requestFor(spec: AnonymousTranslationSpec, config: Config): { url: URL; init: RequestInit } {
  const url = endpointUrl(spec.provider, config)
  const source = language(spec.sourceLanguage, spec.provider)
  const target = language(spec.targetLanguage, spec.provider)
  switch (spec.provider) {
    case 'google': {
      const form = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: spec.text })
      for (const key of form.keys()) url.searchParams.delete(key)
      return { url, init: { method: 'POST', body: form.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' } } }
    }
    case 'bing': {
      if (source !== 'auto') url.searchParams.set('from', source)
      else url.searchParams.delete('from')
      url.searchParams.set('to', target)
      url.searchParams.set('isEnterpriseClient', 'false')
      return { url, init: { method: 'POST', body: JSON.stringify([spec.text]),
        headers: { 'content-type': 'application/json' } } }
    }
    case 'deeplx': return { url,
      init: { method: 'POST', body: JSON.stringify({ text: spec.text, source_lang: source, target_lang: target }),
        headers: { 'content-type': 'application/json' } } }
    /* v8 ignore next -- TranslationProvider is a closed typed union; JSON/config validation owns admission. */
    default: return assertNever(spec.provider)
  }
}

function invalidResponse(provider: AnonymousTranslationProvider): TranslationError {
  return new TranslationError('TRANSLATION_INVALID_RESPONSE', `${provider} returned an invalid translation response`)
}

function translationOf(payload: unknown, provider: AnonymousTranslationProvider): string {
  switch (provider) {
    case 'deeplx': {
      if (typeof payload !== 'object' || payload === null || !('data' in payload)) throw invalidResponse(provider)
      const data: unknown = payload.data
      if (typeof data !== 'string') throw invalidResponse(provider)
      return data
    }
    case 'google': {
      if (!Array.isArray(payload)) throw invalidResponse(provider)
      const first: unknown = payload[0]
      if (!Array.isArray(first) || first.length === 0) throw invalidResponse(provider)
      const segments: unknown[] = first
      return segments.map((segment) => {
        if (!Array.isArray(segment)) throw invalidResponse(provider)
        const text: unknown = segment[0]
        if (typeof text !== 'string') throw invalidResponse(provider)
        return text
      }).join('')
    }
    case 'bing': {
      if (!Array.isArray(payload)) throw invalidResponse(provider)
      const first: unknown = payload[0]
      if (typeof first !== 'object' || first === null || !('translations' in first) || !Array.isArray(first.translations)) {
        throw invalidResponse(provider)
      }
      const translated: unknown = first.translations[0]
      if (typeof translated !== 'object' || translated === null || !('text' in translated) || typeof translated.text !== 'string') {
        throw invalidResponse(provider)
      }
      return translated.text
    }
    /* v8 ignore next -- TranslationProvider is a closed typed union; JSON/config validation owns admission. */
    default: return assertNever(provider)
  }
}

async function responseJson(response: Response, config: Config, provider: AnonymousTranslationProvider): Promise<unknown> {
  if (response.body === null) throw invalidResponse(provider)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > config.maxResponseBytes) {
        await reader.cancel()
        throw new TranslationError('TRANSLATION_RESPONSE_LIMIT', `${provider} translation response exceeds ${config.maxResponseBytes} bytes`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return payload
  } catch (_error) {
    throw new TranslationError('TRANSLATION_INVALID_RESPONSE', `${provider} returned invalid translation JSON`)
  }
}

/**
 * Send one bounded request without cookies, credentials, redirects or provider fallback.
 * @param spec - resolved text and provider-language choices.
 * @param config - endpoints, deadline and response-byte limit.
 * @param signal - caller and service lifetime cancellation.
 * @returns provider-translated text, or a safe failure preserving cancellation.
 */
export async function translateText(spec: AnonymousTranslationSpec, config: Config, signal: AbortSignal): Promise<string> {
  using timeout = deadline(signal, config.timeoutMs, 'TRANSLATION_TIMEOUT')
  try {
    timeout.signal.throwIfAborted()
    if (spec.text === '') return ''
    const { url, init } = requestFor(spec, config)
    const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: timeout.signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw new TranslationError('TRANSLATION_HTTP_ERROR', `${spec.provider} translation failed (HTTP ${response.status})`)
    }
    const payload = await responseJson(response, config, spec.provider)
    timeout.signal.throwIfAborted()
    return translationOf(payload, spec.provider)
  } catch (error) {
    const expired = timeoutOf(timeout.signal, 'TRANSLATION_TIMEOUT')
    if (expired !== undefined && expired !== signal.reason) {
      throw new TranslationError('TRANSLATION_TIMEOUT', `${spec.provider} translation timed out after ${expired.timeoutMs}ms`)
    }
    timeout.signal.throwIfAborted()
    if (error instanceof TranslationError) throw error
    throw new TranslationError('TRANSLATION_REQUEST_FAILED', `${spec.provider} translation request failed`)
  }
}
