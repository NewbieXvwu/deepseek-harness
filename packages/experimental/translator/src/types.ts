/** Provider-independent inputs to the experimental translation service. */
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Anonymous endpoint protocol selected for one translation. */
export type AnonymousTranslationProvider = 'google' | 'bing' | 'deeplx' | 'chatjimmy'

/** Built-in DeepSeek credential routes, admitted by their exact `deepseek-flash` catalog membership. */
export type NativeTranslationProvider = 'deepseek-account' | 'deepseek-official'

/** Model routes that translate a fragment: the built-in DeepSeek routes and one configured provider and model. */
export type ModelTranslationProvider = NativeTranslationProvider | 'llm'

/** Explicit anonymous endpoint or model route. */
export type TranslationProvider = AnonymousTranslationProvider | ModelTranslationProvider

/** Text and provider-supported language tags supplied by a consumer. */
export interface TranslationRequest {
  /** Complete text submitted to the selected provider. */
  readonly text: string
  /** Destination language; common Chinese locale tags are normalized per provider. */
  readonly targetLanguage: string
  /** Source language; omission uses automatic detection. */
  readonly sourceLanguage?: string
  /** Endpoint selection; omission uses the service's configured provider. */
  readonly provider?: TranslationProvider
  /** Existing Session for durable results; a cache miss requires it to be active. Omission keeps the call stateless. */
  readonly sessionId?: SessionId
}

/** Fully resolved text and language choices shared by every provider. */
interface TranslationSpecFields {
  /** Complete text submitted to the selected provider. */
  readonly text: string
  /** Destination language tag. */
  readonly targetLanguage: string
  /** Source language tag, or `auto` for automatic detection. */
  readonly sourceLanguage: string
  /** Existing Session for durable translation records. */
  readonly sessionId?: SessionId
}

/** Fully resolved anonymous endpoint request. */
export interface AnonymousTranslationSpec extends TranslationSpecFields { readonly provider: AnonymousTranslationProvider }

/** Fully resolved built-in DeepSeek request with its required durable Session identity. */
export interface NativeTranslationSpec extends TranslationSpecFields {
  readonly provider: NativeTranslationProvider
  /** Existing durable Session; required before paid request admission. */
  readonly sessionId: SessionId
}

/** Fully resolved request on the configured provider and model route. */
export interface ModelTranslationSpec extends TranslationSpecFields {
  readonly provider: 'llm'
  /** Existing durable Session; required before model request admission. */
  readonly sessionId: SessionId
}

/** Fully resolved routing and language choices for one provider request. */
export type TranslationSpec = AnonymousTranslationSpec | NativeTranslationSpec | ModelTranslationSpec

/** Provider-independent identity of one reusable translation. */
export interface TranslationIdentity {
  /** Explicit provider route; results from different providers remain distinct. */
  readonly provider: string
  /** Exact submitted source fragment. */
  readonly text: string
  /** Requested source language, including automatic detection. */
  readonly sourceLanguage: string
  /** Requested destination language. */
  readonly targetLanguage: string
  /** Protocol, endpoint, or model/prompt settings that affect translation semantics. */
  readonly recipe: string
}

/** One translation attempt, committed durably before external dispatch. */
export interface TranslationRequestRecord extends TranslationIdentity {
  /** Optional provider-owned request details; contains no credential values. */
  readonly metadata?: Record<string, unknown>
}

/** Successful translated text linked to its durable request attempt. */
export interface TranslationResultRecord {
  /** Sequence of the preceding translator request in the same Session. */
  readonly requestSeq: SessionSeq
  /** Complete validated translation. */
  readonly text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Provider-independent translation input, retained before dispatch. */
    'plugin:translator/request': TranslationRequestRecord
    /** Successful translation, retained before it is returned to the consumer. */
    'plugin:translator/result': TranslationResultRecord
  }
}

/** Failures distinct from caller cancellation and service disposal. */
export type TranslationErrorCode = 'TRANSLATION_TEXT_LIMIT' | 'TRANSLATION_HTTP_ERROR'
  | 'TRANSLATION_INVALID_RESPONSE' | 'TRANSLATION_RESPONSE_LIMIT' | 'TRANSLATION_REQUEST_FAILED' | 'TRANSLATION_TIMEOUT'
  | 'TRANSLATION_SESSION_REQUIRED' | 'TRANSLATION_SESSION_INACTIVE' | 'TRANSLATION_STORAGE_ERROR'
  | 'TRANSLATION_ENDPOINT_INVALID' | 'TRANSLATION_UNAVAILABLE'
