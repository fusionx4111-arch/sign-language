import base64
import binascii
import math
import threading


class LandmarkService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hands = None
        self._face = None
        self._cv2 = None
        self._mp = None
        self._np = None
        self.import_error = None
        try:
            import cv2
            import mediapipe as mp
            import numpy as np

            self._cv2 = cv2
            self._mp = mp
            self._np = np
            if not hasattr(mp, "solutions"):
                self.import_error = (
                    "Installed MediaPipe does not expose the solutions API; "
                    "install the pinned version from requirements.txt."
                )
        except ImportError as error:
            self.import_error = str(error)

    @property
    def available(self) -> bool:
        return self.import_error is None

    def _ensure_models(self) -> None:
        if self._hands is None:
            self._hands = self._mp.solutions.hands.Hands(
                static_image_mode=False,
                max_num_hands=2,
                min_detection_confidence=0.45,
                min_tracking_confidence=0.45,
            )
            self._face = self._mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=False,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )

    def _features(self, landmarks) -> list[float]:
        points = self._np.array(
            [[point.x, point.y, point.z] for point in landmarks.landmark],
            dtype=self._np.float32,
        )
        origin = points[0].copy()
        points -= origin
        scale = float(self._np.max(self._np.linalg.norm(points[:, :2], axis=1)))
        if scale < 1e-6:
            raise ValueError("Degenerate hand landmarks")
        points /= scale
        return points.flatten().round(6).tolist()

    def _eye_aspect_ratio(self, landmarks) -> float | None:
        if len(landmarks) < 468:
            return None

        def distance(first: int, second: int) -> float:
            a, b = landmarks[first], landmarks[second]
            return math.hypot(a.x - b.x, a.y - b.y)

        left_width = distance(33, 133)
        right_width = distance(362, 263)
        if left_width < 1e-6 or right_width < 1e-6:
            return None
        left = (distance(159, 145) + distance(158, 153)) / (2 * left_width)
        right = (distance(386, 374) + distance(385, 380)) / (2 * right_width)
        if not math.isfinite(left + right):
            return None
        return (left + right) / 2

    def analyze(self, image_data: str) -> dict:
        encoded = image_data.split(",", 1)[-1]
        if not self.available:
            raise RuntimeError(f"Vision dependencies are unavailable: {self.import_error}")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("Frame must contain valid base64-encoded image data") from error
        image = self._cv2.imdecode(
            self._np.frombuffer(raw, dtype=self._np.uint8), self._cv2.IMREAD_COLOR
        )
        if image is None:
            raise ValueError("Frame could not be decoded as an image")

        with self._lock:
            self._ensure_models()
            rgb = self._cv2.cvtColor(image, self._cv2.COLOR_BGR2RGB)
            hand_result = self._hands.process(rgb)
            face_result = self._face.process(rgb)

        hands = []
        if hand_result.multi_hand_landmarks:
            handedness = hand_result.multi_handedness or []
            for index, landmarks in enumerate(hand_result.multi_hand_landmarks):
                points = [
                    {"x": round(point.x, 5), "y": round(point.y, 5)}
                    for point in landmarks.landmark
                ]
                label = "Unknown"
                if index < len(handedness) and handedness[index].classification:
                    label = handedness[index].classification[0].label
                hands.append(
                    {"handedness": label, "landmarks": points, "features": self._features(landmarks)}
                )

        eye_ratio = None
        if face_result.multi_face_landmarks:
            eye_ratio = self._eye_aspect_ratio(
                face_result.multi_face_landmarks[0].landmark
            )
        return {
            "hands": hands,
            "face_detected": eye_ratio is not None,
            "eye_aspect_ratio": round(eye_ratio, 4) if eye_ratio is not None else None,
            "eyes_closed": eye_ratio is not None and eye_ratio < 0.19,
        }
