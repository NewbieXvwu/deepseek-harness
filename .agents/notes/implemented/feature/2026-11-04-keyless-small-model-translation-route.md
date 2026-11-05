# Agent Note: A keyless small-model route refuses rather than serves bad translations

Status: implemented

English | [中文](2026-11-04-keyless-small-model-translation-route.zh.md)

## Problem

The reasoning-translation panel offered three keyless endpoints — Bing, Google, self-hosted DeepLX — and two paid model choices. ChatJimmy is a fourth keyless option: a shared hosted service that answers `POST /api/chat` with plain text and needs no credential. Its default model is a legacy 8B instruction model, measured here at roughly one request per second and about twenty requests per minute before `HTTP 429`. That model fails in ways the other routes never do: it answers an imperative fragment instead of translating it, prefixes a courtesy, wraps the reply in the prompt's own delimiters, switches between Simplified and Traditional glyphs, drops half a sentence, or continues writing past it. A sample run of the naive single-line instruction — the wording the anonymous routes use — left 18 of 71 adversarial sentences untranslated, repeated, or otherwise unusable. Shipping that as a translation option would put leaked prompt text and hallucinations in front of the reader.

## Decision

`chatjimmy` joins the anonymous provider list and calls the upstream endpoint directly: `{ messages, chatOptions, attachment }` in, plain text with a `<|stats|>…<|/stats|>` telemetry trailer out. It does not go through `ctx.llm`, and the OpenAI-compatible wrapper that circulates for this service is not part of the integration. The [anonymous endpoints decision](../architecture/2026-10-05-anonymous-reasoning-translation.md) owns this provider family, its normalization of destination language, its refusal to switch provider after a failure and its disclosure; this record extends only the list of keyless providers that family covers.

Three measured choices make the route usable:

- **Prompt.** Name the destination script, not just the language — `Simplified Chinese (简体中文)` — put the fragment between `<<< >>>`, and end the turn with `Translation:` as a completion cue. Naming the script removed the Traditional glyph drift; the cue is what stops the model from treating the fragment as a request to answer.
- **Decoding.** `topK: 1` with `temperature: 0`. Greedy sampling measured cleaner than warm sampling on the same prompt, and it makes a cached fragment reproducible.
- **Refusal over repair.** The reply is unwrapped of a copied delimiter and of a leading label that names the destination language or script — the model writes `简体中文：` above its own translation often enough to be a defect class — then refused, `TRANSLATION_INVALID_RESPONSE`, if it is left in the source language, repeats or contains the fragment, repeats itself, mixes Traditional glyphs into a Simplified request, keeps a prompt marker, is materially shorter or longer than the fragment needs, or reports a finish other than `stop`. Every refused fragment shows the reader the original reasoning.

Measured over 561 English fragments through the shipped route: 542 served with no remaining defect and 19 refused by these guards, with zero served replies that leaked the prompt, opened with a courtesy, echoed the fragment, continued it, stayed in English, or kept a language label. Scoring 136 of those served replies against an independent reference translation taken from another anonymous service (`DSH_TRANSLATION_REFERENCE=bing` in the same run) puts the median character overlap at 0.65; reading the 17 below 0.40 found literal rewrites and dropped clauses, and no leakage. The prompt, model id, decoding settings, the shapes the unwrapper accepts, and the endpoint fingerprint live in the stored recipe, so a wording or sampling change cannot serve results cached under the old semantics.

## Alternatives considered

**Few-shot examples.** Three worked pairs ahead of the fragment made things worse: the model copied the delimiter pattern into 31 of 71 replies, because the examples teach its format more strongly than any instruction forbids it.

**Instructions in `systemPrompt` with the bare fragment as the user turn.** 73.2% clean versus 91.5% for the cue format, with the model explaining terms rather than translating them — a chat turn gives it the chance to answer.

**Warm sampling on the same prompt.** 90.1% of the adversarial sentences came back usable against 91.5% under greedy decoding, and sampling noise makes a cached fragment's quality irreproducible.

**More prohibitions in the instruction.** Every added prohibition measured worse than the wording above: a never-respond or no-label clause copied the prompt's own `<<< >>>` markers into 4 of 14 and 10 of 28 replies, and a framing that drops the leading imperative, so the model receives no request to answer, echoed them in 6 and 9 of 18. Naming a form teaches that form. The shipped wording is what survived four rounds of comparison.

**A refusal keyed on grammatical person.** A reply that answers the fragment instead of translating it usually opens with a first-person subject the English source does not have. Over 187 realistic fragments the rule fired twice, and both replies were correct translations whose clauses the model had reordered, so the guard would have withheld good output.

**A tighter length floor.** Raising the dropped-text guard from half of the fragment's word count to all of it would have caught two truncated replies among 178 served fragments — and hidden two correct ones, a reply whose content sits in a code span and a wordy source translated in twelve characters. Independent reference translations of this corpus average 1.75 Chinese characters per counted word and still reach 1.15 at the fifth percentile, over 204 pairs, so a length ratio cannot separate a compressed translation from a missing one.

**Silent correction of bad replies.** Padding, re-splitting, or guessing the intended translation would hide a route that does not work; a refusal is a claim the reader can act on by choosing another service.

**Registering the service through `dsh-llm-pi-ai`.** That adapter speaks OpenAI- or Anthropic-compatible JSON, which this endpoint does not: it takes `chatOptions` and answers plain text. Modeling it as a chat-completions provider would also offer it as a conversation model, which its quality does not support.

## Consequences

- The route inherits a free shared quota and its operator's availability. Refusals are expected traffic, not defects, and the panel says the service limits requests and its translations can be inaccurate.
- Text sent to ChatJimmy leaves the machine with no credential and no contract. The privacy notice already covering anonymous endpoints applies, and the deployment owns the address through `chatjimmyEndpoint`.
- A refusal costs one request: unlike the paid routes, no result is cached for a refused fragment, so a retry sends the same text again.
- The character-level guards encode this model's failure modes, not a translation protocol. Another model behind the same endpoint is measured against the corpus in `tests/chatjimmy-quality.e2e.ts` before it is trusted.
- What the guards cannot reach is meaning: the model renders an idiom or a technical noun literally, compresses a long fragment into its opening clause, and answers a fragment shaped as a request now and then. The reference-scored run above measures that tail instead of pretending it away, and no local rule separates it from a good translation, so the refusal set covers only the shapes it can name while the panel says the translations can be inaccurate.
