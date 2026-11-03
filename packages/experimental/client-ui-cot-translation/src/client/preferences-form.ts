/** Staged translation preferences across both bundle namespaces, using the shared Plugins form model. */
import { SettingsFormModel, settingsTextField, type SettingsFieldState, type SettingsFieldSpec, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'
import { isTranslationEndpoint, LANGUAGE_PREFERENCE_PATTERN, PROVIDER_PREFERENCES,
  type CotTranslationPreferences, type DeeplxEndpointPreference } from '../preferences.ts'

/** Current drafts and the shared form status. */
export interface TranslationFormState extends SettingsFormShell {
  provider: SettingsFieldState
  targetLanguage: SettingsFieldState
  /** DeepLX address draft; its row stays absent while another service is staged or no translator namespace is served. */
  endpoint: SettingsFieldState
  /** Whether the panel offers the address row: the Host serves the translator namespace and DeepLX is staged. */
  endpointVisible: boolean
}

/** Registration-side form observable and edit callbacks. */
export interface TranslationFormInjected extends SettingsFormActions {
  hooks: { translationForm: SnapshotStore<TranslationFormState> }
}

/** One field name routes an edit or reset to the namespace that owns it. */
const ENDPOINT_FIELD = 'deeplxEndpoint'

/** The service choice that gives the stored address a reader. */
const DEEPLX_PROVIDER: TranslationProvider = 'deeplx'

/** Stages provider, language, and DeepLX address edits until the reader saves them. */
export class TranslationPreferencesForm {
  private readonly selection: SettingsFormModel<CotTranslationPreferences>
  private readonly endpoint: SettingsFormModel<DeeplxEndpointPreference>
  private readonly state: SnapshotStore<TranslationFormState>
  private readonly unsubscribe: (() => void)[]

  /**
   * @param scope - Host-backed configuration form for this plugin.
   * @param endpointScope - Host-backed configuration form for the translator entry the bundle mounts.
   */
  constructor(scope: SettingsFormScope<CotTranslationPreferences>, endpointScope: SettingsFormScope<DeeplxEndpointPreference>) {
    this.selection = new SettingsFormModel(scope, [{
      ...settingsTextField('provider'),
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
    this.endpoint = new SettingsFormModel(endpointScope, [endpointField])
    this.state = createSnapshotStore(this.projection())
    this.unsubscribe = [this.selection.bind(() => this.selection.shell()).subscribe(() => { this.publish() }),
      this.endpoint.bind(() => this.endpoint.shell()).subscribe(() => { this.publish() })]
  }

  /**
   * Build the registration face for the preferences form.
   * @returns draft observable and shared edit/save actions.
   */
  inject(): TranslationFormInjected {
    return { hooks: { translationForm: this.state }, edit: (field, text) => { this.formFor(field).actions().edit(field, text) },
      resetField: (field) => { this.formFor(field).actions().resetField(field) }, save: () => { void this.save() },
      discard: () => { this.selection.actions().discard(); this.endpoint.actions().discard() } }
  }

  /** Release both accepted-preference subscriptions. */
  dispose(): void {
    this.selection.dispose()
    this.endpoint.dispose()
    for (const off of this.unsubscribe) off()
  }

  /**
   * Save the address before the service choice, so DeepLX is selected only after the endpoint it uses has landed.
   * A refused write stops the later one, and every remaining draft stays visible for correction.
   * @returns settlement after every attempted write.
   */
  private async save(): Promise<void> {
    if (this.endpointWrites()) {
      await this.endpoint.save()
      if (this.endpoint.shell().failed) return
    }
    if (this.selection.shell().dirty) await this.selection.save()
  }

  private formFor(field: string): SettingsFormModel<CotTranslationPreferences> | SettingsFormModel<DeeplxEndpointPreference> {
    return field === ENDPOINT_FIELD ? this.endpoint : this.selection
  }

  /** Whether an address draft can still land: the row shows only while DeepLX is staged in a served translator namespace. */
  private endpointWrites(): boolean {
    return this.endpointVisible() && this.endpoint.shell().dirty
  }

  /** Whether the address row is on screen. */
  private endpointVisible(): boolean {
    return this.endpoint.shell().available && this.selection.field('provider').text === DEEPLX_PROVIDER
  }

  /** One status across both namespaces the panel edits. */
  private shell(): SettingsFormShell {
    const selection = this.selection.shell(), endpoint = this.endpoint.shell()
    // A draft in a namespace the panel no longer shows is no pending edit: nothing on screen could change it.
    const staged = this.endpointVisible() ? [selection, endpoint] : [selection]
    return { available: selection.available, writable: selection.writable,
      dirty: staged.some(item => item.dirty), invalid: staged.some(item => item.invalid),
      saving: selection.saving || endpoint.saving, failed: staged.some(item => item.failed) }
  }

  private projection(): TranslationFormState {
    return { ...this.shell(), provider: this.selection.field('provider'), targetLanguage: this.selection.field('targetLanguage'),
      endpoint: this.endpoint.field(ENDPOINT_FIELD), endpointVisible: this.endpointVisible() }
  }

  private publish(): void { this.state.set(this.projection()) }
}
