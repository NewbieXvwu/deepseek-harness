/** Staged translation preferences across both bundle namespaces, using the shared Plugins form model. */
import { SettingsFormModel, settingsTextField, type SettingsFieldState, type SettingsFieldSpec, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'
import { isTranslationEndpoint, LANGUAGE_PREFERENCE_PATTERN, PROVIDER_PREFERENCES,
  type CotTranslationPreferences, type TranslatorPreference } from '../preferences.ts'

/** Current drafts and the shared form status. */
export interface TranslationFormState extends SettingsFormShell {
  provider: SettingsFieldState
  targetLanguage: SettingsFieldState
  /** DeepLX address draft. */
  endpoint: SettingsFieldState
  /** Configured model route drafts, named by the model routes the Host serves. */
  llmProvider: SettingsFieldState
  llmModel: SettingsFieldState
  /** Whether the panel offers the address row: DeepLX is staged, or its draft still needs correction. */
  endpointVisible: boolean
  /** Whether the panel offers the model route picker: that route is staged. */
  modelVisible: boolean
}

/** Registration-side form observable and edit callbacks. */
export interface TranslationFormInjected extends SettingsFormActions {
  hooks: { translationForm: SnapshotStore<TranslationFormState> }
}

/** Fields the panel edits in the translator entry rather than in this plugin's preferences. */
const ENDPOINT_FIELD = 'deeplxEndpoint', LLM_PROVIDER_FIELD = 'llmProvider', LLM_MODEL_FIELD = 'llmModel'

/** The choice that decides which translator row the panel shows. */
const PROVIDER_FIELD = 'provider', DEEPLX_PROVIDER: TranslationProvider = 'deeplx', MODEL_PROVIDER: TranslationProvider = 'llm'

/** Stages provider, language, DeepLX address, and model-route edits until the reader saves them. */
export class TranslationPreferencesForm {
  private readonly selection: SettingsFormModel<CotTranslationPreferences>
  private readonly translator: SettingsFormModel<TranslatorPreference>
  private readonly state: SnapshotStore<TranslationFormState>
  private readonly unsubscribe: (() => void)[]

  /**
   * @param scope - Host-backed configuration form for this plugin.
   * @param translatorScope - Host-backed configuration form for the translator entry the bundle mounts.
   */
  constructor(scope: SettingsFormScope<CotTranslationPreferences>, translatorScope: SettingsFormScope<TranslatorPreference>) {
    this.selection = new SettingsFormModel(scope, [{
      ...settingsTextField(PROVIDER_FIELD),
      parse: (text) => {
        const provider = text.trim()
        return provider === '' ? { kind: 'clear' }
          : PROVIDER_PREFERENCES.some(choice => choice === provider) ? { kind: 'set', value: provider } : undefined
      },
    }, {
      ...settingsTextField('targetLanguage'),
      parse: text => LANGUAGE_PREFERENCE_PATTERN.test(text.trim())
        ? { kind: 'set', value: text.trim() } : undefined,
    }])
    const endpointField: SettingsFieldSpec = {
      ...settingsTextField(ENDPOINT_FIELD),
      parse: (text) => {
        const value = text.trim()
        return value === '' ? { kind: 'clear' } : isTranslationEndpoint(value) ? { kind: 'set', value } : undefined
      },
    }
    // One model owns the translator entry, so an address and a route staged in one visit land in one revision-fenced write.
    this.translator = new SettingsFormModel(translatorScope, [endpointField,
      settingsTextField(LLM_PROVIDER_FIELD), settingsTextField(LLM_MODEL_FIELD)])
    this.state = createSnapshotStore(this.projection())
    this.unsubscribe = [this.selection.bind(() => this.selection.shell()).subscribe(() => { this.publish() }),
      this.translator.bind(() => this.translator.shell()).subscribe(() => { this.publish() })]
  }

  /**
   * Build the registration face for the preferences form.
   * @returns draft observable and shared edit/save actions.
   */
  inject(): TranslationFormInjected {
    return { hooks: { translationForm: this.state }, edit: (field, text) => { this.formFor(field).actions().edit(field, text) },
      resetField: (field) => { this.formFor(field).actions().resetField(field) }, save: () => { void this.save() },
      discard: () => { this.selection.actions().discard(); this.translator.actions().discard() } }
  }

  /** Release both accepted-preference subscriptions. */
  dispose(): void {
    this.selection.dispose()
    this.translator.dispose()
    for (const off of this.unsubscribe) off()
  }

  /**
   * Save the translator entry before the service choice, so a service is selected only after the address or model it
   * uses has landed. A refused write stops the later one, and every remaining draft stays visible for correction.
   * @returns settlement after every attempted write.
   */
  private async save(): Promise<void> {
    if (this.translatorWrites()) {
      await this.translator.save()
      if (this.translator.shell().failed) return
    }
    if (this.selection.shell().dirty) await this.selection.save()
  }

  private formFor(field: string): SettingsFormModel<CotTranslationPreferences> | SettingsFormModel<TranslatorPreference> {
    return field === ENDPOINT_FIELD || field === LLM_PROVIDER_FIELD || field === LLM_MODEL_FIELD ? this.translator : this.selection
  }

  /** Whether a translator-entry draft can still land: its rows show only while the Host serves that entry. */
  private translatorWrites(): boolean {
    const translator = this.translator.shell()
    return translator.available && translator.dirty
  }

  /** Whether the address row is on screen; an unusable draft stays visible so its refusal is never invisible. */
  private endpointVisible(): boolean {
    return this.translator.shell().available
      && (this.selection.field(PROVIDER_FIELD).text === DEEPLX_PROVIDER || this.translator.field(ENDPOINT_FIELD).invalid)
  }

  /** Whether the model route picker is on screen. */
  private modelVisible(): boolean {
    return this.translator.shell().available && this.selection.field(PROVIDER_FIELD).text === MODEL_PROVIDER
  }

  /** One status across both namespaces the panel edits. */
  private shell(): SettingsFormShell {
    const selection = this.selection.shell(), translator = this.translator.shell()
    // A draft in a namespace the panel no longer shows is no pending edit: nothing on screen could change it.
    const staged = translator.available ? [selection, translator] : [selection]
    return { available: selection.available, writable: selection.writable,
      dirty: staged.some(item => item.dirty), invalid: staged.some(item => item.invalid),
      saving: selection.saving || translator.saving, failed: staged.some(item => item.failed) }
  }

  private projection(): TranslationFormState {
    return { ...this.shell(), provider: this.selection.field(PROVIDER_FIELD), targetLanguage: this.selection.field('targetLanguage'),
      endpoint: this.translator.field(ENDPOINT_FIELD), llmProvider: this.translator.field(LLM_PROVIDER_FIELD),
      llmModel: this.translator.field(LLM_MODEL_FIELD), endpointVisible: this.endpointVisible(), modelVisible: this.modelVisible() }
  }

  private publish(): void { this.state.set(this.projection()) }
}
