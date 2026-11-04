/** Browser-safe translation preferences and Remote metadata. */
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'

/** Translation choices; auto targets the active browser UI language. */
export interface CotTranslationPreferences {
  /** Explicit provider selection; requests never fall back to another provider. */
  provider: TranslationProvider
  /** BCP 47 language code, or auto to follow the UI language. */
  targetLanguage: string
}

/** The translator namespace section this panel edits. */
export interface TranslatorPreference {
  /** DeepLX endpoint that receives reasoning when the reader selects DeepLX. */
  deeplxEndpoint: string
  /** Provider id of the configured model route; empty while the reader has not chosen one. */
  llmProvider: string
  /** Model id of the configured model route, matched against that provider's catalog. */
  llmModel: string
}

/** One model route the panel can offer for translation. */
export interface ModelRouteChoice {
  /** Provider id the translator sends the fragment to. */
  provider: string
  /** Provider name as the model page presents it. */
  providerName: string
  /** Model id within that provider. */
  model: string
  /** Model name as the model page presents it. */
  modelName: string
}

/** Authoritative Host metadata read before any reasoning is submitted. */
export interface CotTranslationSnapshot {
  /** Maximum UTF-16 text length accepted by one translation request. */
  maxTextChars: number
  /** Current accepted provider and target-language preferences. */
  preferences: CotTranslationPreferences
  /** Anonymous endpoints, eligible built-in paid routes, and the configured model route when it serves. */
  availableProviders: readonly TranslationProvider[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Provider or input failure, without original text or response details. */
    'cotTranslation/failed': Record<string, never>
  }
}
