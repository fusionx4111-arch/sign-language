# Dataset collection guide

SignBridge includes a pinned model for isolated static A–Z fingerspelling. Custom gesture classes and their examples are stored in the configured MySQL database and must be collected locally.

## What to collect

- One class per clearly described sign, with its label, intended meaning, language, category, and static/dynamic type.
- A minimum of 8 training samples and 2 validation samples per class, from at least 2 distinct contributors. The application does not enable a class for predictions until all these minimums are met.
- A consistent, anonymous contributor ID; do not use a person's name. Keep validation examples separate from training examples and, where possible, reserve contributors for validation.
- Examples under varied lighting, distance, camera angles, signing speed, and left/right-hand use. Handedness is stored with each sample, and predictions only compare examples for the detected hand (unless collected as `any`). Dynamic samples should include the complete movement, not only its start/end pose.
- Informed consent for recording. Obtain appropriate permission and use only datasets/materials with documented legal rights if importing external data.

The current prototype captures normalized 21-point hand landmarks. Face landmarks are detected for status/context but are not interpreted as emotions or used as sign meanings. No raw image or audio is stored by the application.

## Limitations

The included nearest-example and dynamic sequence matching are baseline research/demo methods, not a trained or evaluated general ISL model. The confidence number is a similarity score, not an accuracy estimate or calibrated probability. Test with held-out signers and report per-class precision/recall, overall accuracy, latency, lighting, and user variation before relying on predictions. Do not use this prototype as a substitute for emergency services or a qualified interpreter.

The optional fingerspelling alphabet model recognizes isolated static A–Z
poses. Its dataset score does not establish performance on live camera users.
It does not recognize words or movement-dependent signs.
