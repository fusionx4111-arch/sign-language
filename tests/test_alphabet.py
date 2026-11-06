import json

import numpy as np
import pytest

from backend.alphabet import ISLAlphabetRecognizer, LETTERS


def test_pinned_alphabet_model_loads_and_predicts():
    recognizer = ISLAlphabetRecognizer()

    assert recognizer.available
    assert recognizer.validation_accuracy == pytest.approx(0.8802202845)
    result = recognizer.predict_hands(
        [{"handedness": "Right", "features": np.linspace(0, 1, 63).tolist()}]
    )

    assert result["recognized"] is True
    assert result["letter"] in LETTERS
    assert 0 <= result["confidence"] <= 1


def test_features_are_wrist_centered_scaled_and_placed_left_then_right():
    hand = np.zeros(63, dtype=np.float32)
    hand[3:6] = [10, 0, 0]
    hand[36:39] = [0, 3, 4]

    features = ISLAlphabetRecognizer.features_from_hands(
        [{"handedness": "Left", "features": hand.tolist()}]
    )

    assert features.shape == (126,)
    assert features[3:6] == pytest.approx([2, 0, 0])
    assert features[36:39] == pytest.approx([0, 0.6, 0.8])
    assert np.count_nonzero(features[63:]) == 0


def test_features_reject_missing_or_invalid_hands():
    assert ISLAlphabetRecognizer.features_from_hands([]) is None
    assert ISLAlphabetRecognizer.features_from_hands(
        [{"handedness": "Unknown", "features": [0.0] * 63}]
    ) is None
    assert ISLAlphabetRecognizer.features_from_hands(
        [{"handedness": "Right", "features": [float("nan")] * 63}]
    ) is None


def test_recognizer_rejects_artifact_that_does_not_match_pinned_checksum(tmp_path):
    model_path = tmp_path / "model.joblib"
    metadata_path = tmp_path / "model.json"
    model_path.write_bytes(b"not the pinned classifier")
    metadata_path.write_text(
        json.dumps(
            {
                "supported_labels": list(LETTERS),
                "feature_dimension": 126,
                "scikit_learn_version": "1.6.1",
                "validation_metrics": {"SVC": {"accuracy": 0.88}},
            }
        ),
        encoding="utf-8",
    )

    recognizer = ISLAlphabetRecognizer(model_path, metadata_path)

    assert recognizer.available is False
    assert "checksum" in recognizer.error
    assert recognizer.predict_hands([])["reason"] == "model_unavailable"


def test_analyze_route_returns_alphabet_model_status(monkeypatch):
    from backend import main

    class NoHandLandmarks:
        def analyze(self, image_data):
            return {"hands": [], "face_detected": False, "face_landmarks": []}

    class MissingAlphabetModel:
        available = False

        def predict_hands(self, hands):
            return {
                "recognized": False,
                "letter": None,
                "confidence": 0.0,
                "reason": "model_unavailable",
            }

    monkeypatch.setattr(main, "landmarks", NoHandLandmarks())
    monkeypatch.setattr(main, "alphabet", MissingAlphabetModel())

    result = main.analyze(main.AnalyzeInput(image="test-frame"))

    assert result["alphabet"]["recognized"] is False
    assert result["alphabet"]["reason"] == "model_unavailable"


def test_analyze_only_uses_gestures_that_meet_training_requirements(monkeypatch):
    from contextlib import contextmanager

    from backend import database, main

    class OneHandLandmarks:
        def analyze(self, image_data):
            return {
                "hands": [
                    {
                        "features": [0.0] * 63,
                        "handedness": "Right",
                    }
                ],
                "face_detected": False,
                "face_landmarks": [],
            }

    class NoAlphabetModel:
        def predict_hands(self, hands):
            return {
                "recognized": False,
                "letter": None,
                "confidence": 0.0,
                "reason": "model_unavailable",
            }

    class Connection:
        pass

    ready_ids_used = []

    @contextmanager
    def fake_connect():
        yield Connection()

    def fake_predict(features, sequence, samples, ready_ids, handedness):
        ready_ids_used.append(ready_ids)
        return None

    monkeypatch.setattr(main, "landmarks", OneHandLandmarks())
    monkeypatch.setattr(main, "alphabet", NoAlphabetModel())
    monkeypatch.setattr(database, "connect", fake_connect)
    monkeypatch.setattr(
        database,
        "gesture_rows",
        lambda db: [
            {"id": 1, "ready": False, "sample_count": 1},
            {"id": 2, "ready": True, "sample_count": 10},
        ],
    )
    monkeypatch.setattr(database, "training_samples", lambda db: [])
    monkeypatch.setattr(main, "predict", fake_predict)

    main.analyze(main.AnalyzeInput(image="test-frame"))

    assert ready_ids_used == [{2}]
