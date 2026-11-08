def test_analyze_matches_unvalidated_saved_training_examples(monkeypatch):
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

    class Connection:
        pass

    @contextmanager
    def fake_connect():
        yield Connection()

    monkeypatch.setattr(main, "landmarks", OneHandLandmarks())
    monkeypatch.setattr(database, "connect", fake_connect)
    monkeypatch.setattr(
        database,
        "gesture_rows",
        lambda db: [
            {"id": 1, "ready": False, "sample_count": 1},
            {"id": 2, "ready": True, "sample_count": 10},
        ],
    )
    monkeypatch.setattr(
        database,
        "training_samples",
        lambda db: [
            {
                "id": 1,
                "label": "unvalidated",
                "meaning": "Not ready",
                "language": "en",
                "kind": "static",
                "features": [0.0] * 63,
                "handedness": "any",
            },
            {
                "id": 2,
                "label": "7",
                "meaning": "Number seven",
                "language": "en",
                "kind": "static",
                "features": [2.0] * 63,
                "handedness": "any",
            },
        ],
    )

    result = main.analyze(main.AnalyzeInput(image="test-frame"))

    assert result["gesture"]["label"] == "unvalidated"
    assert result["gestures"] == [result["gesture"]]
    assert "alphabet" not in result
