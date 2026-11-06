import math
from typing import Iterable


FEATURE_SIZE = 63
MIN_TRAIN_SAMPLES = 8
MIN_VALIDATION_SAMPLES = 2
MAX_STATIC_DISTANCE = 0.72
MAX_DYNAMIC_DISTANCE = 0.42


def valid_feature_vector(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == FEATURE_SIZE
        and all(isinstance(item, (int, float)) and math.isfinite(item) for item in value)
    )


def _distance(left: list[float], right: list[float]) -> float:
    if not valid_feature_vector(left) or not valid_feature_vector(right):
        return math.inf
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right)) / FEATURE_SIZE)


def _dtw_distance(left: list[list[float]], right: list[list[float]]) -> float:
    if not left or not right:
        return math.inf
    previous = [math.inf] * (len(right) + 1)
    previous[0] = 0.0
    for left_frame in left:
        current = [math.inf] * (len(right) + 1)
        for index, right_frame in enumerate(right, start=1):
            point_distance = _distance(left_frame, right_frame)
            current[index] = point_distance + min(
                current[index - 1], previous[index], previous[index - 1]
            )
        previous = current
    return previous[-1] / max(len(left), len(right))


def predict(
    features: list[float],
    sequence: list[list[float]],
    samples: Iterable[dict],
    ready_gesture_ids: set[int],
    handedness: str = "Unknown",
) -> dict | None:
    best_by_gesture = {}
    for sample in samples:
        if sample["id"] not in ready_gesture_ids:
            continue
        sample_handedness = sample.get("handedness", "any")
        if sample_handedness not in ("any", handedness):
            continue
        if sample["kind"] == "static":
            distance = _distance(features, sample["features"])
            limit = MAX_STATIC_DISTANCE
        else:
            distance = _dtw_distance(sequence, sample["features"])
            limit = MAX_DYNAMIC_DISTANCE
        if math.isfinite(distance):
            normalized_distance = distance / limit
            current = best_by_gesture.get(sample["id"])
            if current is None or normalized_distance < current[0]:
                best_by_gesture[sample["id"]] = (
                    normalized_distance,
                    distance,
                    limit,
                    sample,
                )

    candidates = sorted(best_by_gesture.values(), key=lambda result: result[0])
    if not candidates:
        return None

    normalized_distance, distance, limit, sample = candidates[0]
    score = max(0.0, min(1.0, 1.0 - normalized_distance))
    margin = (
        candidates[1][0] - normalized_distance
        if len(candidates) > 1
        else math.inf
    )
    accepted = normalized_distance < 1 and (margin >= 0.025 or len(candidates) == 1)
    return {
        "recognized": accepted,
        "gesture_id": sample["id"] if accepted else None,
        "label": sample["label"] if accepted else None,
        "meaning": sample["meaning"] if accepted else None,
        "language": sample["language"] if accepted else None,
        "handedness": sample.get("handedness", "any") if accepted else None,
        "confidence": round(score, 3),
        "reason": None if accepted else "low_confidence_or_ambiguous",
    }
