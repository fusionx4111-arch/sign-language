# Gesture workflow modification proposal

**Status: Approved and implemented.** The user approved the proposed
workflow, selected the workbook phrase sheet as its source, enabled optional
double-blink and index-pointing controls, and chose landmarks-only training.

## Requested experience

### 1. Edit and create reference gestures

- In the ISL Reference edit flow, make it clear whether the user is editing an
  existing reference gesture or adding a new one.
- Offer actions to save the reference entry or open AI Learning Mode to create
  or select the matching recognition class.
- Keep the dictionary entry as the source for its label, meaning, category,
  emoji, and reference photos. Refresh the ISL Reference, Gesture Learning,
  and Gesture Dictionary views from that saved entry so edits and photos stay
  consistent across sections.
- Keep reference photos separate from recognition samples. A picture shown in
  a learning card is illustrative; it does not by itself train the webcam
  recognizer.

### 2. Train a gesture with camera samples

- Open AI Learning Mode with the selected gesture/class filled in.
- Capture webcam landmarks for labelled training and validation samples.
- Preserve the current recognition gate: at least 8 training samples, 2
  validation samples, and 2 contributors before the class becomes eligible for
  recognition.
- Do not save webcam photos or video as training data. Keep dictionary
  reference photos separate from recognition samples.

### 3. Optional double-blink controls

- During a training session, a deliberate double blink could capture/confirm a
  sample. During sentence suggestions, index-finger pointing could move
  backward/forward through candidate phrases and a deliberate double blink
  could select and speak one.
- Make these hands-free controls opt-in, visibly indicate when they are active,
  add a cooldown and confirmation state, and retain buttons/keyboard controls
  as alternatives. Ordinary blinks must not unexpectedly save data, select a
  phrase, or start speech.
- A gesture may produce candidate letters, but letter-to-sentence suggestions
  should be presented as suggestions for the user to confirm—not as a
  guaranteed translation.

### 4. Daily-use phrases

- Use the approved `ISL_phrase_dictionary.xlsx` `Phrases` sheet, preserving
  English, Hindi, category, initial letter, and priority in the app data.
- Filter suggestions by recognized letter and let the user review, select,
  and speak an idea. These are not translations.

## Privacy, storage, and behavior limits

- Camera frames and eye measurements are processed locally and are not saved
  by training. Training samples contain hand landmarks only.
- Double-blink detection uses face/eye landmarks and may be unreliable with
  glasses, lighting, or camera placement. Never make blink controls the only
  way to train, browse, select, or speak.
- The custom recognizer matches collected landmark examples; it does not
  retrain the built-in A–Z classifier. Static photos cannot teach
  movement-dependent signs.
- Existing MySQL database contents should be preserved during any schema
  migration.

## Implemented phases

1. Make reference metadata and photos render consistently in ISL Reference,
   Gesture Learning, and the ISL tab of Gesture Dictionary.
2. Provide explicit “edit”, “add new”, and “train this gesture” choices, with
   training routed to the existing gated AI Learning Mode.
3. Add the approved workbook phrase suggestions with manual selection,
   sentence insertion, and speech.
4. Add opt-in double-blink and index-pointing controls with manual alternatives
   and focused tests. Training remains landmarks-only; no sample media is
   recorded.

## Implemented behavior

- The phrase list is served from `/api/phrase-suggestions` and shown for
  recognized A–Z letters with manual selection, arrow-button/key navigation,
  sentence insertion, and speech.
- Pointing navigation and double-blink selection are opt-in and disabled by
  default. Training double-blink capture is a separate opt-in control.
- Training saves only selected hand landmarks; no sample photo or video is
  captured. Reference photos remain separate illustrative dictionary media.
- Edits and reference photos refresh the ISL Reference, Gesture Learning, and
  ISL Dictionary views from the same reference records.
