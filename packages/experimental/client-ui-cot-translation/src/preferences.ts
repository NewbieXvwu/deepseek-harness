/** Shared validation for Host configuration and browser preference drafts. */
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'

export type { CotTranslationPreferences, CotTranslationSnapshot, ModelRouteChoice, TranslatorPreference } from './types.ts'

/** Language preference accepted by both Host configuration and browser drafts. */
export const LANGUAGE_PREFERENCE_PATTERN = /^(?:auto|[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*)$/

/** Explicit provider choices accepted by Host configuration and browser drafts. */
export const PROVIDER_PREFERENCES = [
  'bing', 'google', 'deeplx', 'deepseek-account', 'deepseek-official', 'llm',
] as const satisfies readonly TranslationProvider[]

/**
 * Match the endpoint form the translator accepts, so the panel blocks a save that the Host would reject.
 * @param value - trimmed draft text from the address control.
 * @returns whether the draft is an HTTP(S) URL without credentials or a fragment.
 */
export function isTranslationEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.hash === ''
  } catch (_error) {
    return false
  }
}
