from backend.recognition import FEATURE_SIZE, predict, valid_feature_vector
from backend.vision import LandmarkService


def test_feature_vector_validation():
    assert valid_feature_vector([0.0] * FEATURE_SIZE)
    assert not valid_feature_vector([0.0] * 5)
    assert not valid_feature_vector([float("nan")] * FEATURE_SIZE)


def test_prediction_requires_a_ready_class():
    sample = {
        "id": 1,
        "label": "hello",
        "meaning": "Hello",
        "language": "en",
        "kind": "static",
        "features": [0.0] * FEATURE_SIZE,
    }
    assert predict([0.0] * FEATURE_SIZE, [], [sample], set()) is None


def test_prediction_rejects_far_and_accepts_matching_sample():
    sample = {
        "id": 1,
        "label": "hello",
        "meaning": "Hello",
        "language": "en",
        "kind": "static",
        "features": [0.0] * FEATURE_SIZE,
    }
    result = predict([0.0] * FEATURE_SIZE, [], [sample], {1})
    assert result["recognized"] is True
    assert result["confidence"] == 1.0
    rejected = predict([2.0] * FEATURE_SIZE, [], [sample], {1})
    assert rejected["recognized"] is False
    assert rejected["meaning"] is None


def test_same_class_examples_do_not_create_false_ambiguity():
    first = {
        "id": 1,
        "label": "hello",
        "meaning": "Hello",
        "language": "en",
        "kind": "static",
        "features": [0.0] * FEATURE_SIZE,
    }
    second = {**first, "features": [0.01] * FEATURE_SIZE}
    result = predict([0.0] * FEATURE_SIZE, [], [first, second], {1})
    assert result["recognized"] is True


def test_left_and_right_samples_are_matched_to_the_detected_hand():
    sample = {
        "id": 1,
        "label": "hello",
        "meaning": "Hello",
        "language": "en",
        "kind": "static",
        "features": [0.0] * FEATURE_SIZE,
        "handedness": "Left",
    }
    assert predict([0.0] * FEATURE_SIZE, [], [sample], {1}, "Left")["recognized"] is True
    assert predict([0.0] * FEATURE_SIZE, [], [sample], {1}, "Right") is None


def test_landmark_normalization_returns_wrist_relative_features():
    class Point:
        def __init__(self, x, y, z):
            self.x, self.y, self.z = x, y, z

    class Landmarks:
        landmark = [Point(index / 20, (index % 4) / 10, 0.0) for index in range(21)]

    service = LandmarkService()
    features = service._features(Landmarks())
    assert len(features) == FEATURE_SIZE
    assert features[:3] == [0.0, 0.0, 0.0]
