# RFC: Clydie v0.3 — Grounded exploration

**Status:** Proposed specification, not implemented  
**Scope:** Clydie's controller-facing epistemic interface, records, tests, and evaluation  
**Principle:** **The paper has the authority to contradict the explorer.**

## 1. Why this change?

Origami Lab invites a small model to play with paper without a construction objective. Clydie's approved invitation is good and must remain **verbatim**. The problem is not a shortage of instructions to be curious: the model is filling gaps in sparse tactile data with familiar prose about what paper *ought* to feel like.

In a local Qwen 3 4B run after the invitation change, Clydie made 30 decisions and issued 40 motor commands (19 `beginTrace` and 11 `move` decisions). It received 17 surface-contact acquisition events, no snap or resistance events, never acquired a grip, and left the sheet unchanged. Yet its own three `observation` notes described smoothness, resilience, varying texture, and increasing stiffness. The sensory protocol measures none of those properties. They were not observations. Some notes even described effects of the action **being proposed**, whose outcome was not yet available.

The experiment demonstrates an *epistemic channel error*: a model-authored narrative can acquire the status of observed fact merely by being labeled `observation` and reintroduced as `notebook` memory. It does **not** demonstrate that a better prompt alone will produce novel folds.

The proposed remedy is to separate (a) what the tactile environment actually returned from (b) what Clydie wonders, supposes, likes, or decides to try.

## 2. Goals and non-goals

**Goals**

1. Give Clydie an authoritative, low-cost record of *reported sensations*, including ordinary non-events and changes across actions.
2. Keep model-generated questions and conjectures visible, without presenting them as sensory facts.
3. Make the temporal order unambiguous: an action is proposed, the host executes it, the host records the feedback, and only then may a later decision interpret that feedback.
4. Help a 4B local model use the actual action/feedback loop without prescribing what it must investigate.
5. Preserve the existing zero-thickness material semantics, tactile limitations, controller parity, historical episode replay, and honest experimental comparisons.

**Non-goals**

- Do not add a fold target, progress reward, novelty score, compulsory question, curiosity ranking, or automatic steering toward a corner.
- Do not claim that text instructions eliminate confabulation or automatically verify the truth of natural-language conjectures.
- Do not invent sensors for texture, resilience, pressure, stiffness, sound, or friction.
- Do not change the physical validator, sensing radii, motor bounds, or success criteria in this milestone.
- Do not infer hidden geometry, target locations, or physical causes from host diagnostics.

## 3. The epistemic contract

There are two distinct sources of information.

### 3.1 Sensory record: host-authored, authoritative *as a report*

The host records only what its tactile interface actually measured or reported: motor position, hand mode, contact class, proximity, available landmark kind/intensity, snap state, grip events, resistance, and accepted/rejected/unverified outcomes. It may compute **literal differences** between readings and count reported events. This record is read-only to the controller.

“Authoritative” means *faithful to the current simulator and its declared sensors*, **not** a claim that the simulation measures the full physics of real paper. For example:

- `contact: "surface"` reports contact with an exposed facet; it does **not** report smoothness or texture.
- `proximity: 0` reports no feature proximity signal in the available sensing band; it does **not** prove the sheet is uniform or that no edge exists.
- `events: []` means no *reported event in that command*, not that no physical phenomenon could have occurred.
- A contact-loss/contact-reacquisition pair from `beginTrace` at a new location indicates **lifting and repositioning**, not continuous travel over intervening paper.
- A `move` command may result in several interpolated motor commands. Their ordered tactile results, not just the endpoint, are the evidence available after execution.
- The host must not recast model speculation as observed fact, even when the speculation sounds plausible.

### 3.2 Inquiry record: controller-authored, expressly provisional

Clydie may optionally record a `question`, `conjecture`, or `reflection`, each with bounded free text. It is free not to write a note. These notes are **not** observations and receive no privileged evidentiary status. It may propose interpretations that are false, playful, or worth investigating, but the interface must not present them later as sensations.

The host attaches the current **pre-action motor index** to each note. A note in decision `d` can refer only to feedback from motor commands preceding `d`. The host never uses natural-language interpretation to change the paper, upgrade a validation outcome, or decide a “correct” next action.

In particular, a note like “Perhaps the edge becomes stiffer” is a permissible conjecture **only if presented as a supposition**. “I felt the edge grow stiffer” is an unsupported sensory assertion, because stiffness is absent from the available sensor vocabulary. This distinction is subject to independent evaluation; the runtime is **not** expected to solve natural-language entailment.

## 4. The decision cycle

Keep **one model inference per decision**, not an extra reasoning call after every motor command.

1. The host supplies the present hand state, recent **already executed** tactile readings, a compact factual sensory memory, and optional prior inquiry notes.
2. Clydie emits one supported action and may append a question, conjecture, or reflection about **earlier** experience.
3. The host validates the response; invalid replies issue no motor commands and receive a format correction.
4. The host executes the action through the existing tactile hand. `move` may be interpolated into several motor commands, each producing feedback.
5. The host projects the actual feedback through the existing whitelist (`observe`), computes literal sensory deltas, and updates its factual memory.
6. The next inference receives that result. No account of the newly proposed action's outcome appears before it has happened.

This implements **act → sense → interpret/choose → act** without giving the model a privileged geometry API or an extra oracle.

## 5. Controller-facing data: proposed v2 view

Keep the existing physical action names, coordinate conventions, and validation path. Change only the *epistemic organization* of the controller's input/output.

The exact TypeScript factoring is an implementation decision, but the v2 view must preserve these logical fields:

~~~ts
type InquiryNote = {
  kind: 'question' | 'conjecture' | 'reflection';
  text: string;                 // bounded; optional in a decision
  beforeMotorIndex: number;     // assigned by host, not model
};

type SensoryStep = {
  motorIndex: number;
  action: Action;               // already executed, not proposed
  sense: ReturnType<typeof observe>;  // existing safe projection
  delta: {
    // Only literal, reproducible comparisons of reported readings.
    // Keep source values available; never replace them with a diagnosis.
    contact?: {from: string | null; to: string | null};
    proximity?: {from: number; to: number};
    snapped?: {from: boolean; to: boolean};
    landmark?: {from: unknown; to: unknown};
    events: ReturnType<typeof observe>['events'];
    noReportedChange: boolean;
  };
};

type GroundedView = {
  handMode: 'idle' | 'tracing' | 'dragging';
  motor: {x: number; y: number};
  recent: SensoryStep[];            // bounded actual motor history
  sensoryMemory: SensoryFact[];     // bounded, host-derived; see `5.1
  inquiryNotebook: InquiryNote[];  // bounded, model-authored
  correction?: string;
};
~~~

`SensoryFact` is an implementation-defined compact representation of **reported** contact, grip, snap, resistance, landmark, or validation events (and counts/ranges of identical readings). Each fact includes its originating motor index or range. It must be deterministically reproducible from the recorded motor commands and filtered feedback.

**Do not duplicate unlimited raw trajectories in the model prompt.** The full canonical tactile trajectory already belongs in the saved episode. The model view uses bounded windows. Default limits should remain usable with the existing 4096-token local context and should be benchmarked on the user's Qwen configuration.

### 5.1 Rules for the host's compact sensory memory

- Construct it **solely** from `observe(feedback, command)` and previously reported readings, not from the full internal paper mesh, diagnostic reason strings, hidden target coordinates, facet IDs, or model notes.
- Preserve actual contact classes and the fact of reported change. No prose such as “the edge is stiffer,” “the paper is smooth,” or “an edge is approaching” unless the precise claim is itself a sensor field.
- A genuine `surface` reading is informative, but twenty identical readings are not twenty discoveries. Consecutive equivalent readings can be coalesced with a count and motor range. Do not silently erase a grip failure, resisted move, contact-class transition, snap, landmark cue, or validator outcome.
- A comparison may say “contact remained surface; proximity stayed 0; no new event was reported.” It must not say “the paper did not change” or “nothing was there.”
- Where feedback contains several within-command events, show their **reported order**; an unchanged endpoint is not proof the intervening path lacked a feature.
- Keep the existing `grip-failed` versus `resistance` distinction and tactile trajectory v3's stationary-tracing semantics intact.
- All memory truncation/coalescing rules are deterministic, documented, and visible in episode metadata. Missing history is explicitly bounded, not silently treated as absent experience.

### 5.2 One illustrative interaction

When the host receives an ordinary tracing sample at `(0.9, 0.5)` after an earlier surface reading with proximity zero, it might supply:

~~~json
{
  "action": {"action": "move", "at": {"x": 0.9, "y": 0.5}},
  "sense": {
    "motor": {"x": 0.9, "y": 0.5},
    "contact": "surface",
    "proximity": 0,
    "snapped": false,
    "outcome": null,
    "events": [],
    "omittedEvents": 0
  },
  "delta": {"events": [], "noReportedChange": true}
}
~~~

That is not evidence of new texture or stiffness. Clydie could legitimately ask “Would the contact change if I went farther?” and select an action to find out. Nothing requires it to do so.

## 6. Prompt and action schema

### 6.1 Preserve the invitation exactly

The opening paragraphs adopted in PR #38 are a **protected constant** and must remain identical, including paragraph breaks. The grounding instructions go **after** that invitation, in a clearly separate technical sensing section.

Proposed *technical* addition (to review during implementation):

> Your hand only reports the sensor fields in your view: contact, proximity, landmarks, snapping, grip, resistance, and validation outcomes. It does not report texture, stiffness, pressure, warmth, or elasticity. A zero proximity reading is not proof of uniformity. A new beginTrace location lifts and replaces your finger; move follows a path while tracing or dragging. The action you choose now has not happened yet; its results arrive with your next view. Your optional notes are questions, conjectures, or reflections about what you have encountered so far, not additional sensory measurements. Guesses are welcome when labeled as guesses. You may pursue, change, or abandon any question.

This is a **measurement contract**, not a suggestion to find corners or complete folds. Do not use a negative reward or runtime scolding for ungrounded statements.

### 6.2 Output format

Keep the current JSON action alternatives and strict parsing, including `beginDrag`, `beginTrace`, `move`, `release`, `mark`, `flip`, `unfold`, and `stop`. The optional `note` field remains but changes its `kind` vocabulary to `question | conjecture | reflection`. The host, rather than the model, stamps note provenance (`beforeMotorIndex`).

Retain the 240-character text ceiling initially. The model need not include a note. **Do not** add a required rationale, evidence score, action preference, target geometry, or reward field.

Both Ollama and LM Studio must receive **the same** approved invitation, sensing contract, projected view semantics, and JSON schema (with provider-specific request envelopes only).

## 7. Record format, history, and audit

- Use a new Clydie **episode protocol/version** for the changed controller view and note vocabulary (e.g. `episode.version = 2`); do **not** unnecessarily change `trajectory.version = 3` or the canonical Origami Lab experiment format. The tactile world is unchanged.
- Preserve old v1 records exactly. Historical `observation` notes remain legible as **model-authored legacy text**, not host observations; do not silently rewrite them into v2 facts. Historical replay must continue to verify under the saved tactile versions.
- Save the exact invitation, appended technical contract, JSON schema, response, prior view, notes, model/seed/generation options, and each decision's motor range as the runner already does.
- Save the authoritative raw tactile trace. If projected sensory memory is saved, recompute it during replay/audit and reject discrepancies; otherwise derive it reproducibly during inspection.
- The `inspect` CLI should display **Observed (host)** separately from **Inquiry (model)**, with indices showing which events were visible before each note.
- Maintain honest incomplete-trajectory handling, limits, failed-provider diagnostics, and separate model-generated versus host-generated data.
- An optional new offline report may flag **candidate** unsupported sensory claims for human review; it must never imply automatic truth certification.

## 8. Tests and acceptance criteria

### Contract tests

1. **Verbatim invitation:** assert the entire approved opening text, not just keywords; it is identical across model providers.
2. **Authoritative separation:** model-supplied notes, including text claiming “smoothness” or “stiffness,” are **never** inserted into `sensoryMemory` or represented as host readings.
3. **Temporal order:** a note proposed with a `move` can cite only prior motor indices. The `move` feedback appears only in a subsequent view. The same applies to interpolated moves and invalid responses.
4. **Empty reading:** repeated trace at the same point produces no new reported contact event; it must not be promoted to a novelty claim.
5. **Lift versus motion:** `beginTrace` at a different coordinate reports lift/recontact without implying sensory access to the intervening segment; `move` preserves its real path feedback.
6. **Faithful changes:** zero proximity / ordinary surface / absent snap produces exactly the appropriate literal deltas; transitions, intermediate events, grip acquisition/failure, and resistance remain faithfully distinguishable.
7. **Privacy:** projected view and memories contain no raw event positions, target coordinates, hidden identities, facet IDs, or validator diagnostic reasons beyond the existing `observe` whitelist.
8. **Boundedness:** fixed limits on sensor and inquiry memory; exact, deterministic coalescing; no unbounded prompt growth on a long uniform trace.
9. **Compatibility:** replays of existing v1 episodes still verify; current full tactile test suite remains green; v2 episodes reconstruct the same material state.
10. **Providers:** mock LM Studio and Ollama requests carry the same protocol, without a second model call or action bypass.

### Behavioral evaluation (not runtime rewards)

Freeze the November 27 40-command episode as a historical baseline and run new v0.3 episodes with the same Qwen model, LM Studio setup, 40-command budget, and seeds (start with 17; then two additional seeds). Record model identifier, context, sampling settings, code revision, and prompt version. Sampling is not guaranteed deterministic even at a fixed seed.

Inspect results in two independent dimensions:

- **Grounding:** count model-authored **declarative sensory claims not supported by prior reported feedback**; distinguish explicitly tentative conjectures. Have a human check the claims against time-stamped evidence. This is the primary question.
- **Engagement:** spatial coverage, new contact classes, proximity/snap/grip encounters, use of continuous `move` vs lift/reposition, and whether later choices respond to *actual* sensory changes. Note emergent questions and possible revisits, but do not require any particular behavior.

**Success for implementation** means accurate source separation, truthful presentation of sensor readings, reproducible records, and compatibility. **Success for research** remains open: even a model that asks no questions or never folds is informative. Do not declare victory merely because its prose is quieter.

## 9. Implementation plan and boundaries

A small reviewable sequence is preferable:

1. **Protocol and temporal schema:** protect the exact invitation; add the technical sensing contract; use optional `question/conjecture/reflection` notes; version the model-facing view; test prior-action provenance. Do not alter the action language.
2. **Host sensory memory:** derive bounded, literal change records from `observe`; separate sensor memory from inquiry memory; expose both in `inspect`; maintain full raw traces and version-aware replay.
3. **Verification and experiment:** run existing tests and frozen-record replays, execute a 40-command local LM Studio comparison, and document both successes and failures. Do not silently tune the prompt between seeds.

### Explicitly deferred

If the model still sees only ordinary surface readings, run a **separate**, controlled investigation of motor/feature resolution and affordance discoverability. Current proximity sensing begins only near exposed features, whereas the recorded model mostly chose coarse interior positions. Changes to hit bands, action primitives, or feedback richness must be independently motivated, tested with human gestures, and evaluated separately from this epistemic refactor.

## 10. The design test

Ask of every new field: **Could the paper actually have told Clydie this?**

If not, the field belongs in Clydie's inquiry, an evaluator's commentary, or nowhere—not in the host's sensory record.

The goal is not to prevent imagination. It is to give imagination something that can resist it.
