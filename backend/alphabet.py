import hashlib
import json
import math
from pathlib import Path

import numpy as np


ROOT_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = ROOT_DIR / "models" / "signspeak_model.joblib"
METADATA_PATH = ROOT_DIR / "models" / "model_metadata.json"
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
FEATURE_SIZE = 126
SCIKIT_LEARN_VERSION = "1.6.1"
MODEL_SHA256 = "F9E39D339BF7A4CC882BA0BBB112039898A10F69C13A35429F4A75FDA7D1C9D0"
COMMIT_CONFIDENCE_THRESHOLD = 0.5


class ISLAlphabetRecognizer:
    def __init__(
        self,
        model_path: Path = MODEL_PATH,
        metadata_path: Path = METADATA_PATH,
    ) -> None:
        self._model = None
        self._metadata = None
        self._error = None
        if not model_path.exists() and not metadata_path.exists():
            self._error = "The ISL alphabet model is not installed."
            return
        if not model_path.is_file() or not metadata_path.is_file():
            self._error = "The ISL alphabet model or its metadata file is missing."
            return
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if (
                metadata.get("supported_labels") != list(LETTERS)
                or metadata.get("feature_dimension") != FEATURE_SIZE
                or metadata.get("scikit_learn_version") != SCIKIT_LEARN_VERSION
            ):
                raise ValueError("The ISL alphabet model metadata is incompatible.")
            metrics = metadata.get("validation_metrics", {}).get("SVC", {})
            validation_accuracy = float(metrics.get("accuracy"))
            if not math.isfinite(validation_accuracy) or not 0 <= validation_accuracy <= 1:
                raise ValueError("The ISL alphabet model validation metrics are invalid.")

            digest = hashlib.sha256(model_path.read_bytes()).hexdigest().upper()
            if digest != MODEL_SHA256:
                raise ValueError("The ISL alphabet model checksum does not match the pinned artifact.")

            import joblib
            import sklearn

            if sklearn.__version__ != SCIKIT_LEARN_VERSION:
                raise ValueError(
                    f"The model requires scikit-learn {SCIKIT_LEARN_VERSION}; "
                    f"found {sklearn.__version__}."
                )
            model = joblib.load(model_path)
            if (
                not hasattr(model, "predict_proba")
                or getattr(model, "n_features_in_", None) != FEATURE_SIZE
                or [str(label) for label in model.classes_] != list(LETTERS)
            ):
                raise ValueError("The ISL alphabet model has an incompatible feature layout.")
            self._model = model
            self._metadata = metadata
        except (
            AttributeError,
            EOFError,
            ImportError,
            OSError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            self._error = f"Could not load the ISL alphabet model: {error}"

    @property
    def available(self) -> bool:
        return self._model is not None and self._metadata is not None

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def validation_accuracy(self) -> float | None:
        if not self._metadata:
            return None
        return float(self._metadata["validation_metrics"]["SVC"]["accuracy"])

    @staticmethod
    def features_from_hands(hands: list[dict]) -> np.ndarray | None:
        processed = []
        for hand in hands:
            features = hand.get("features")
            if not features:
                continue
            points = np.asarray(features, dtype=np.float32)
            if points.shape != (63,) or not np.isfinite(points).all():
                continue
            points = points.reshape(21, 3)
            points = points - points[0]
            scale = float(np.linalg.norm(points[12]))
            if not math.isfinite(scale) or scale < 1e-6:
                continue
            norm = (points / scale).flatten()
            wrist_x = hand.get("landmarks", [{}])[0].get("x", 0.5) if hand.get("landmarks") else 0.5
            processed.append({
                "handedness": hand.get("handedness", "Unknown"),
                "wrist_x": wrist_x,
                "features": norm
            })

        if not processed:
            return None

        if len(processed) == 1:
            h = processed[0]
            if h["handedness"] == "Left":
                return np.concatenate([h["features"], np.zeros(63, dtype=np.float32)]).astype(np.float32)
            else:
                return np.concatenate([np.zeros(63, dtype=np.float32), h["features"]]).astype(np.float32)

        # When 2 hands are present:
        # Sort spatially across screen so leftmost hand is in slot 1 and rightmost in slot 2.
        # This prevents MediaPipe handedness misclassification from overwriting or dropping a hand.
        # Candidates will then evaluate both [Left, Right] and [Right, Left] against the model.
        processed.sort(key=lambda item: item["wrist_x"])
        h_left = processed[0]["features"]
        h_right = processed[1]["features"]
        return np.concatenate([h_left, h_right]).astype(np.float32)

    def predict_hands(self, hands: list[dict]) -> dict:
        if not self.available:
            return {
                "recognized": False,
                "letter": None,
                "confidence": 0.0,
                "reason": "model_unavailable",
            }

        features = self.features_from_hands(hands)
        if features is None:
            return {
                "recognized": False,
                "letter": None,
                "confidence": 0.0,
                "reason": "no_hand",
            }

        candidates = [features, np.concatenate((features[63:], features[:63]))]
        predictions = [
        self._model.predict_proba(candidate.reshape(1, -1))[0]
        for candidate in candidates
        ]
        probabilities = max(
        predictions, key=lambda values: float(np.max(values))
        )
        index = int(np.argmax(probabilities))
        confidence = float(probabilities[index])
        return {
            "recognized": True,
            "letter": str(self._model.classes_[index]),
            "confidence": round(confidence, 3),
            "reason": None,
        }
