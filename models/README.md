# ISL alphabet model

The local application uses `signspeak_model.joblib`, a pinned A–Z MediaPipe
landmark classifier from
[SignSpeak-AI](https://github.com/arpita1505/SignSpeak-AI) at revision
`6fc64c720e168d32f3c1a968d797be4af56e36cb`. Its SHA-256 is
`F9E39D339BF7A4CC882BA0BBB112039898A10F69C13A35429F4A75FDA7D1C9D0`.
`model_metadata.json` records its feature format and reported dataset metrics.
The source repository declares MIT, while its model metadata does not make a
separate artifact-license statement; retain the upstream notice and check the
upstream terms before redistributing the weights.

The model expects two 63-value hand slots: left then right, with a missing hand
zero-filled. Each hand is wrist-centered and divided by its 3D wrist-to-middle-
finger-tip distance. The recognizer derives this layout from the same
MediaPipe landmarks used by the hand display.

The upstream model card reports 90.55% accuracy on its held-out RealSign test
split. Signer IDs were unavailable, so that score may overstate performance on
new signers. Probabilities are not formally calibrated. This model recognizes
isolated static A–Z poses, not words or movement-dependent signs.
