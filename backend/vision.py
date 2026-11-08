import base64
import binascii
import math
import threading


class LandmarkService:
    LEFT_EYE_CONTOUR = (33, 160, 159, 158, 133, 153, 145, 144)
    RIGHT_EYE_CONTOUR = (362, 385, 386, 387, 263, 373, 374, 380)

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
                refine_landmarks=True,
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

    def _eye_aspect_ratios(self, landmarks) -> tuple[float, float] | None:
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
        return left, right

    def _eye_aspect_ratio(self, landmarks) -> float | None:
        ratios = self._eye_aspect_ratios(landmarks)
        return sum(ratios) / 2 if ratios is not None else None

    @staticmethod
    def _both_eyes_closed(ratios: tuple[float, float] | None) -> bool:
        return ratios is not None and all(value < 0.19 for value in ratios)

    @staticmethod
    def _point(point) -> dict[str, float]:
        return {"x": round(point.x, 5), "y": round(point.y, 5)}

    def _eye_landmarks(self, landmarks) -> dict | None:
        if len(landmarks) < 478:
            return None
        return {
            "contours": [
                [self._point(landmarks[index]) for index in contour]
                for contour in (self.LEFT_EYE_CONTOUR, self.RIGHT_EYE_CONTOUR)
            ],
            "irises": [
                self._point(landmarks[468]),
                self._point(landmarks[473]),
            ],
        }

    def _eye_gaze_x(self, landmarks) -> float | None:
        if len(landmarks) < 478:
            return None
        eye_positions = []
        for first, last, iris_start in ((33, 133, 468), (362, 263, 473)):
            edge_a = landmarks[first].x
            edge_b = landmarks[last].x
            width = abs(edge_b - edge_a)
            if width < 1e-6:
                return None
            iris_x = sum(landmarks[index].x for index in range(iris_start, iris_start + 5)) / 5
            eye_positions.append((iris_x - min(edge_a, edge_b)) / width)
        gaze_x = sum(eye_positions) / len(eye_positions)
        return gaze_x if math.isfinite(gaze_x) else None

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
                    {
                        "x": round(point.x, 5),
                        "y": round(point.y, 5),
                        "z": round(point.z, 5),
                    }
                    for point in landmarks.landmark
                ]
                label = "Unknown"
                if index < len(handedness) and handedness[index].classification:
                    label = handedness[index].classification[0].label
                hands.append(
                    {"handedness": label, "landmarks": points, "features": self._features(landmarks)}
                )

        eye_ratios = None
        eye_landmarks = None
        gaze_x = None
        if face_result.multi_face_landmarks:
            face_points = face_result.multi_face_landmarks[0].landmark
            eye_ratios = self._eye_aspect_ratios(face_points)
            eye_landmarks = self._eye_landmarks(face_points)
            gaze_x = self._eye_gaze_x(face_points)
        eye_ratio = sum(eye_ratios) / 2 if eye_ratios is not None else None
        return {
            "hands": hands,
            "face_detected": eye_ratio is not None,
            "eye_aspect_ratio": round(eye_ratio, 4) if eye_ratio is not None else None,
            "eye_aspect_ratios": (
                [round(value, 4) for value in eye_ratios]
                if eye_ratios is not None
                else None
            ),
            "eyes_closed": self._both_eyes_closed(eye_ratios),
            "eye_gaze_x": round(gaze_x, 4) if gaze_x is not None else None,
            "eye_landmarks": eye_landmarks,
        }
