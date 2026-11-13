const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];
const state = {
  stream: null, timer: null, busy: false, currentFeatures: null, currentHandedness: "Unknown", sequence: [],
  gestureClasses: [], history: [], recognition: null, lastAppended: null,
  stableLabel: null, stableCount: 0, serviceUnavailable: false,
  stableLetter: null, stableLetterCount: 0, lastAppendedLetter: null,
  formedLetter: null, clearedLetter: null,
  selectedEmergency: null, customPhrases: [],
  phraseCache: new Map(), phraseSuggestions: [], selectedPhraseIndex: -1,
  phraseMode: "offline",
  phraseLetter: null, phraseRequestId: 0, recognizedLetter: null,
  blinkClosedAt: null, lastBlinkAt: null, blinkCooldownUntil: 0,
  pointAnchorX: null, pointCooldownUntil: 0,
  gazeDirection: null, gazeCooldownUntil: 0,
  eyeOpenRatio: null, eyeClosedRatio: null, eyeClosedThreshold: null, eyeGazeCenter: null,
  eyeCalibrationCapture: null, blinkPracticeCount: 0,
  pointPracticeCounts: { left: 0, right: 0 }
};
const defaultPhrases = [
  "I need help.", "Please call a doctor.", "I need water.", "Call my family.",
  "I am feeling unwell.", "Please help me.", "I need assistance."
];

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local service at ${window.location.origin}. ` +
      "Start the app from the project folder with .\\.venv\\Scripts\\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000, " +
      "then open http://127.0.0.1:8000."
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function navigate(page) {
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  const active = $(`#page-${page}`);
  $("#page-title").textContent = active?.querySelector("h1")?.textContent || "Dashboard";
  if (page === "history") loadHistory();
  if (page === "dictionary") { loadGestures(); setupDictTabs(); }
  if (page === "recognition") loadGestures();
  if (page === "isl-reference") setupIslReference();
  if (page === "gesture-learn") setupGestureLearn();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function speechLanguage() {
  return $("#speech-language").value;
}

function speak(text) {
  if (!text.trim()) return toast("There is no text to speak.");
  if (!("speechSynthesis" in window)) return toast("Text-to-speech is not supported by this browser.");
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLanguage();
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find((voice) => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
    || voices.find((voice) => voice.lang.toLowerCase().startsWith(utterance.lang.slice(0, 2).toLowerCase()));
  if (match) utterance.voice = match;
  utterance.onerror = (event) => toast(`Speech playback failed: ${event.error}`);
  window.speechSynthesis.speak(utterance);
}

function speakSuggestedSentence(text) {
  if (!text.trim()) return toast("There is no sentence to speak.");
  if (!("speechSynthesis" in window)) return toast("Text-to-speech is not supported by this browser.");
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLanguage();
  utterance.rate = 0.88;
  utterance.pitch = 1;
  utterance.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const languagePrefix = utterance.lang.slice(0, 2).toLowerCase();
  const match = voices.find((voice) => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
    || voices.find((voice) => voice.lang.toLowerCase().startsWith(languagePrefix));
  if (match) utterance.voice = match;
  utterance.onerror = (event) => toast(`Speech playback failed: ${event.error}`);
  window.speechSynthesis.speak(utterance);
}

function toggleSpeechPause() {
  if (!("speechSynthesis" in window)) return toast("Text-to-speech is not supported by this browser.");
  if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) window.speechSynthesis.pause();
  else if (window.speechSynthesis.paused) window.speechSynthesis.resume();
  else toast("There is no active speech to pause.");
}

async function saveHistory(mode, text, confidence = null) {
  if (!text.trim()) return;
  try {
    await api("/api/history", { method: "POST", body: JSON.stringify({ mode, text: text.trim(), confidence }) });
    await refreshStats();
  } catch (error) {
    toast(error.message);
  }
}

async function refreshStats() {
  try {
    const [health, gestures, history] = await Promise.all([
      api("/api/health"), api("/api/gestures"), api("/api/history")
    ]);
    $("#service-status").textContent = health.database !== "connected"
      ? "Database connection unavailable"
      : health.vision_available ? "Local AI service ready" : "Vision dependencies unavailable";
    $("#system-status").textContent = health.vision_available
      ? `MySQL connected. ${health.recognition}`
      : `MySQL connected; camera analysis is unavailable: ${health.vision_error || "install requirements first."}`;
    $("#stat-gestures").textContent = gestures.length;
    $("#stat-ready").textContent = gestures.filter((item) => item.ready).length;
    $("#stat-history").textContent = history.length;
    state.gestureClasses = gestures;
    renderRecent(history.slice(0, 3));
    renderGestures(gestures);
  } catch (error) {
    $("#service-status").textContent = "Local service unavailable";
    $("#system-status").textContent = error.message;
  }
}

function renderRecent(items) {
  const container = $("#recent-activity");
  if (!items.length) {
    container.innerHTML = '<p class="empty-state">Your saved conversations will appear here.</p>';
    return;
  }
  container.innerHTML = items.map((item) => `
    <div class="history-item"><span class="history-mode">${item.mode === "speech" ? "♫" : "◉"}</span>
      <div class="history-content"><strong>${escapeHtml(item.text)}</strong><small>${escapeHtml(item.mode)} · ${formatDate(item.created_at)}</small></div>
    </div>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatDate(value) {
  const isoValue = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(isoValue) ? isoValue : `${isoValue}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera access requires a supported browser and localhost or HTTPS.");
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    for (const track of state.stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (state.stream?.getTracks().includes(track)) {
          stopCamera();
          toast("Camera disconnected. Your sentence and ready-to-speak suggestions are still available.");
        }
      }, { once: true });
    }

    const videos = [$("#camera-video"), $("#learning-camera-video")].filter(Boolean);
    for (const v of videos) {
      v.srcObject = state.stream;
      try { await v.play(); } catch (_) {}
    }

    // Update Live Recognition UI
    if ($("#camera-placeholder")) $("#camera-placeholder").hidden = true;
    if ($("#camera-start")) $("#camera-start").disabled = true;
    if ($("#camera-stop")) $("#camera-stop").disabled = false;
    if ($("#camera-badge")) {
      $("#camera-badge").textContent = "● Camera active";
      $("#camera-badge").style.color = "#26845b";
    }

    // Update AI Learning UI
    if ($("#learning-camera-placeholder")) $("#learning-camera-placeholder").hidden = true;
    if ($("#learning-camera-start")) $("#learning-camera-start").disabled = true;
    if ($("#learning-camera-stop")) $("#learning-camera-stop").disabled = false;
    if ($("#learning-camera-badge")) {
      $("#learning-camera-badge").textContent = "● Camera active";
      $("#learning-camera-badge").style.color = "#26845b";
    }
    if ($("#sample-hand-indicator")) $("#sample-hand-indicator").textContent = "Camera active, waiting for hands...";

    $("#stat-camera").textContent = "Active";
    $("#compact-camera-state").textContent = "Camera is active. Hand landmark tracking is running.";
    state.serviceUnavailable = false;
    analyzeFrame();
    toast("Camera started. Keep your hands clearly visible.");
  } catch (error) {
    const detail = error.name === "NotAllowedError"
      ? "Camera permission was denied. Allow access in your browser settings."
      : error.name === "NotFoundError" ? "No camera was found on this device." : error.message;
    toast(detail);
  }
}

function stopCamera() {
  clearTimeout(state.timer);
  state.timer = null;
  cancelRecordCountdown();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.busy = false;
  state.currentFeatures = null;
  state.allHands = [];
  state.sequence = [];
  state.eyeCalibrationCapture = null;

  const videos = [$("#camera-video"), $("#learning-camera-video")].filter(Boolean);
  videos.forEach(v => { v.srcObject = null; });

  const canvases = [$("#landmark-canvas"), $("#learning-landmark-canvas")].filter(Boolean);
  canvases.forEach(c => {
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  });

  if ($("#camera-placeholder")) $("#camera-placeholder").hidden = false;
  if ($("#camera-start")) $("#camera-start").disabled = false;
  if ($("#camera-stop")) $("#camera-stop").disabled = true;
  if ($("#camera-badge")) {
    $("#camera-badge").textContent = "● Camera off";
    $("#camera-badge").style.color = "";
  }

  if ($("#learning-camera-placeholder")) $("#learning-camera-placeholder").hidden = false;
  if ($("#learning-camera-start")) $("#learning-camera-start").disabled = false;
  if ($("#learning-camera-stop")) $("#learning-camera-stop").disabled = true;
  if ($("#learning-camera-badge")) {
    $("#learning-camera-badge").textContent = "● Camera off";
    $("#learning-camera-badge").style.color = "";
  }
  if ($("#learning-hand-status")) $("#learning-hand-status").textContent = "No hand detected";
  if ($("#eye-calibration-status")) $("#eye-calibration-status").textContent = "Start the camera and face it to begin.";
  if ($("#point-practice-status")) $("#point-practice-status").textContent = "Waiting for a hand.";
  if ($("#sample-hand-indicator")) $("#sample-hand-indicator").textContent = "Camera off";

  $("#stat-camera").textContent = "Off";
  $("#hand-status").textContent = "No hand detected";
  $("#face-status").textContent = "Face landmarks: waiting";
  $("#compact-camera-state").textContent = "Start camera from Live recognition to begin.";
  if ($("#record-sample")) $("#record-sample").disabled = true;
  if ($("#record-countdown-btn")) $("#record-countdown-btn").disabled = true;
  if ($("#recognized-word")) {
    $("#recognized-word").textContent = "Camera is offline";
    $("#recognition-detail").textContent = "Your sentence remains on screen. Choose a suggested sentence to add it and hear it spoken.";
    $("#confidence-value").textContent = "—";
    $("#confidence-bar").style.width = "0%";
  }
  state.recognizedLetter = null;
  state.stableLetter = null;
  state.stableLetterCount = 0;
  state.lastAppendedLetter = null;
  updateLearnedLetter();
}

function drawLandmarksOnCanvas(canvas, video, result) {
  if (!canvas || !video || !video.videoWidth) return;
  const context = canvas.getContext("2d");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.clearRect(0, 0, canvas.width, canvas.height);

  (result.hands || []).forEach((hand, idx) => {
    const isRight = hand.handedness === "Right";
    const lineColor = isRight ? "#71f0bc" : "#80d8ff";
    const dotColor = isRight ? "#24c88a" : "#00b0ff";

    context.beginPath();
    HAND_CONNECTIONS.forEach(([start, end]) => {
      const first = hand.landmarks[start];
      const second = hand.landmarks[end];
      if (!first || !second) return;
      context.moveTo(first.x * canvas.width, first.y * canvas.height);
      context.lineTo(second.x * canvas.width, second.y * canvas.height);
    });
    context.strokeStyle = lineColor;
    context.lineWidth = Math.max(2.5, canvas.width / 300);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(10, 24, 35, 0.9)";
    context.shadowBlur = 4;
    context.stroke();
    context.shadowBlur = 0;

    hand.landmarks.forEach((point) => {
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(3, canvas.width / 240), 0, Math.PI * 2);
      context.fillStyle = "#ffffff";
      context.strokeStyle = dotColor;
      context.lineWidth = Math.max(1.5, canvas.width / 500);
      context.fill();
      context.stroke();
    });

    // Draw label above wrist
    if (hand.landmarks && hand.landmarks[0]) {
      const wrist = hand.landmarks[0];
      const tag = `${hand.handedness || 'Hand ' + (idx + 1)}`;
      context.font = "bold 13px Manrope, sans-serif";
      context.fillStyle = isRight ? "#24c88a" : "#00b0ff";
      context.shadowColor = "rgba(0,0,0,0.8)";
      context.shadowBlur = 4;
      context.fillText(tag, Math.max(8, wrist.x * canvas.width - 20), Math.max(16, wrist.y * canvas.height - 10));
      context.shadowBlur = 0;
    }
  });

  const eyes = result.eye_landmarks;
  if (eyes?.contours?.length) {
    eyes.contours.forEach((contour) => {
      if (!contour.length) return;
      context.beginPath();
      contour.forEach((point, index) => {
        const x = point.x * canvas.width;
        const y = point.y * canvas.height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.strokeStyle = "#ffd166";
      context.lineWidth = Math.max(2, canvas.width / 400);
      context.shadowColor = "rgba(10, 24, 35, 0.9)";
      context.shadowBlur = 4;
      context.stroke();
      context.shadowBlur = 0;
      contour.forEach((point) => {
        context.beginPath();
        context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(2, canvas.width / 400), 0, Math.PI * 2);
        context.fillStyle = "#ffffff";
        context.fill();
      });
    });
    (eyes.irises || []).forEach((point) => {
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(4, canvas.width / 180), 0, Math.PI * 2);
      context.fillStyle = "#ff6b7a";
      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(2, canvas.width / 400);
      context.fill();
      context.stroke();
    });
  }
}

function drawLandmarks(result) {
  const vRec = $("#camera-video");
  const cRec = $("#landmark-canvas");
  if (vRec && cRec) drawLandmarksOnCanvas(cRec, vRec, result);

  const vLearn = $("#learning-camera-video");
  const cLearn = $("#learning-landmark-canvas");
  if (vLearn && cLearn) drawLandmarksOnCanvas(cLearn, vLearn, result);
}

async function analyzeFrame() {
  if (state.busy || !state.stream) return;
  const vRec = $("#camera-video");
  const vLearn = $("#learning-camera-video");
  const video = (vLearn && vLearn.videoWidth > 0 && !vLearn.closest(".page")?.classList.contains("hidden"))
    ? vLearn : (vRec && vRec.videoWidth > 0 ? vRec : (vLearn && vLearn.videoWidth > 0 ? vLearn : null));

  if (!video || !video.videoWidth) {
    state.timer = setTimeout(analyzeFrame, 100);
    return;
  }
  state.busy = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = Math.round(video.videoHeight * (480 / video.videoWidth));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.7);
    const result = await api("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ image, sequence: state.sequence.slice(-20) })
    });
    drawLandmarks(result);
    if (state.serviceUnavailable) {
      state.serviceUnavailable = false;
      $("#service-status").textContent = "Local service connected";
      toast("Local service reconnected.");
    }
    state.allHands = result.hands || [];
    const handCount = state.allHands.length;
    let handDesc = "No hand detected";
    if (handCount === 1) {
      handDesc = `${state.allHands[0].handedness || "One"} hand detected`;
    } else if (handCount >= 2) {
      handDesc = `2 hands detected (${state.allHands.map(h => h.handedness).join(" & ")})`;
    }

    $("#hand-status").textContent = handDesc;
    if ($("#learning-hand-status")) $("#learning-hand-status").textContent = handDesc;
    if ($("#face-status")) $("#face-status").textContent = result.face_detected ? "Face landmarks: detected" : "Face landmarks: not detected";
    updateEyePractice(result);

    state.currentFeatures = result.hands[0]?.features || null;
    state.currentHandedness = result.hands[0]?.handedness || "Unknown";
    if (state.currentFeatures) {
      state.sequence.push(state.currentFeatures);
      state.sequence = state.sequence.slice(-30);
    } else {
      state.sequence = [];
    }

    // AI learning mode hand readiness
    const targetHand = $("#sample-target-hand")?.value || "any";
    let readyToRecord = false;
    if (handCount > 0) {
      if (targetHand === "any") readyToRecord = true;
      else if (targetHand === "Both") readyToRecord = handCount >= 2;
      else readyToRecord = state.allHands.some(h => h.handedness === targetHand);
    }

    if ($("#record-sample")) $("#record-sample").disabled = !readyToRecord;
    if ($("#record-countdown-btn") && !countdownTimer && !countdownResetTimer) {
      $("#record-countdown-btn").disabled = !readyToRecord;
    }
    if ($("#learning-camera-message")) {
      $("#learning-camera-message").textContent = readyToRecord
        ? `Hands ready (${handDesc}). Click Record or Countdown.`
        : (handCount === 0 ? "No hand detected. Keep your hands visible in the frame." : `Please show ${targetHand} hand in frame.`);
    }
    if ($("#sample-hand-indicator")) {
      $("#sample-hand-indicator").textContent = readyToRecord
        ? `✅ Ready to record (${handDesc})`
        : `⚠️ Waiting for ${targetHand} hand (${handDesc})`;
    }

    updateRecognition(result.gesture, result.gestures);
    updateLearnedLetter();
    handleOptInCameraControls(result);
  } catch (error) {
    $("#recognized-word").textContent = "Analysis unavailable";
    $("#recognition-detail").textContent = error.message;
    $("#hand-status").textContent = "Analysis unavailable";
    $("#service-status").textContent = "Local service unavailable";
    state.currentFeatures = null;
    state.sequence = [];
    state.eyeCalibrationCapture = null;
    $("#record-sample").disabled = true;
    $("#record-countdown-btn").disabled = true;
    if ($("#eye-calibration-status")) {
      $("#eye-calibration-status").textContent = "Camera analysis unavailable. Restart the local service and try again.";
    }
    $("#learning-camera-message").textContent = "Start the local service to analyze camera frames.";
    drawLandmarks({ hands: [] });
    if (!state.serviceUnavailable) toast(error.message);
    state.serviceUnavailable = true;
  } finally {
    state.busy = false;
    if (state.stream) {
      state.timer = setTimeout(analyzeFrame, state.serviceUnavailable ? 2500 : cameraControlEnabled() ? 180 : 300);
    }
  }
}

function updateRecognition(gesture, gestures = []) {
  const recognizedGestures = (gestures || []).filter(g => g && g.recognized);
  const recognized = gesture?.recognized || recognizedGestures.length > 0;
  const letterGesture = recognizedGestures.find(g => /^[A-Z]$/i.test(g.label || ""));
  const activeGesture = letterGesture || (gesture?.recognized ? gesture : recognizedGestures[0]);
  state.recognizedLetter = recognized && /^[A-Z]$/i.test(activeGesture?.label || "")
    ? activeGesture.label.toUpperCase()
    : null;
  const readyClasses = state.gestureClasses.filter((item) => item.ready).length;
  const configuredClasses = state.gestureClasses.length;
  let detail;

  if (recognizedGestures.length > 1) {
    // Both hands recognized!
    $("#recognized-word").textContent = recognizedGestures.map(g => `${g.handedness || 'Hand'}: ${g.meaning}`).join("  |  ");
    detail = recognizedGestures.map(g => `${g.label} (${g.handedness})`).join(" & ");
  } else if (recognized) {
    const active = gesture?.recognized ? gesture : recognizedGestures[0];
    $("#recognized-word").textContent = active.meaning;
    detail = `${active.label} (${active.handedness || 'any'}) · ${active.language === "hi" ? "Hindi" : "English"}`;
  } else if (!state.currentFeatures) {
    $("#recognized-word").textContent = "Show your hand to the camera";
    detail = "Keep your hand centered in the camera frame.";
  } else {
    const totalSamples = state.gestureClasses.reduce((sum, c) => sum + (c.sample_count || 0), 0);
    const totalTrainingSamples = state.gestureClasses.reduce((sum, c) => sum + (c.train_count || 0), 0);
    if (totalSamples === 0) {
      $("#recognized-word").textContent = "No gesture samples recorded";
      detail = "Go to AI Learning Mode and record at least 1 sample for a gesture to recognize it.";
    } else if (totalTrainingSamples === 0) {
      $("#recognized-word").textContent = "No training examples saved";
      detail = "Validation examples are held out of live matching. Select Training sample in AI Learning Mode and record examples for this class.";
    } else if (readyClasses === 0) {
      $("#recognized-word").textContent = "Matching saved training examples";
      detail = "This class is not fully validated yet. For better testing, collect at least 8 training samples, 2 validation samples, and samples from 2 contributors.";
    } else {
      $("#recognized-word").textContent = "Hold gesture steady";
      detail = gesture?.reason === "low_confidence_or_ambiguous"
        ? "Gesture held, but confidence was low. Adjust angle slightly."
        : "Matching against your trained gesture classes...";
    }
  }
  $("#recognition-detail").textContent = detail;
  const confidence = gesture?.confidence ?? 0;
  $("#confidence-value").textContent = gesture ? `${Math.round(confidence * 100)}% similarity` : "—";
  $("#confidence-bar").style.width = `${Math.round(confidence * 100)}%`;
  $("#recognition-icon").style.background = recognized ? "#e8f7ef" : "#eeefff";
  $("#recognition-icon").style.color = recognized ? "#26845b" : "#776cda";
  if (recognized) {
    if (state.stableLabel === gesture.meaning) state.stableCount += 1;
    else { state.stableLabel = gesture.meaning; state.stableCount = 1; }
    const addAsLetter = /^[A-Z]$/i.test(gesture.label || "") && $("#auto-add-letters").checked;
    if (state.stableCount >= 3 && $("#auto-add").checked && !addAsLetter && state.lastAppended !== gesture.meaning) {
      appendSentence(gesture.meaning);
      state.lastAppended = gesture.meaning;
      saveHistory("sign", gesture.meaning, confidence);
    }
  } else {
    state.stableLabel = null;
    state.stableCount = 0;
    state.lastAppended = null;
  }
}

function updateLearnedLetter() {
  const letter = state.recognizedLetter;
  const output = $("#alphabet-word");
  const detail = $("#alphabet-detail");
  const visibleLetter = state.formedLetter
    || (letter && letter !== state.clearedLetter ? letter : null);
  output.textContent = visibleLetter || "—";
  detail.textContent = state.formedLetter
    ? `Phrase ideas are for ${state.formedLetter}. Clear the letter to reset suggestions.`
    : visibleLetter
    ? "Matched from your saved AI Learning Mode samples."
    : "Train a letter in AI Learning Mode to recognize it here.";

  if (!letter) {
    state.stableLetter = null;
    state.stableLetterCount = 0;
    state.lastAppendedLetter = null;
    state.clearedLetter = null;
  } else if (letter === state.clearedLetter) {
    state.stableLetter = null;
    state.stableLetterCount = 0;
  } else {
    state.clearedLetter = null;
    if (state.stableLetter === letter) state.stableLetterCount += 1;
    else {
      state.stableLetter = letter;
      state.stableLetterCount = 1;
    }
    if (state.stableLetterCount >= 3) state.formedLetter = letter;
    if (state.stableLetterCount >= 3 && $("#auto-add-letters").checked && state.lastAppendedLetter !== letter) {
      const field = $("#sentence-text");
      field.value += letter;
      updateSentenceCount();
      state.lastAppendedLetter = letter;
    }
  }
  $("#clear-recognized-letter").disabled = !state.formedLetter;
  updatePhraseSuggestions(state.formedLetter);
}

function clearRecognizedLetter() {
  state.clearedLetter = state.recognizedLetter;
  state.formedLetter = null;
  state.stableLetter = null;
  state.stableLetterCount = 0;
  state.phraseRequestId += 1;
  renderOfflineSuggestions();
  updateLearnedLetter();
}

async function updatePhraseSuggestions(letter) {
  const normalized = /^[A-Z]$/i.test(letter || "") ? letter.toUpperCase() : null;
  if (!normalized) return;
  if (normalized === state.phraseLetter && state.phraseMode === "letter") return;
  state.phraseMode = "letter";
  state.phraseLetter = normalized;
  state.selectedPhraseIndex = -1;
  const requestId = ++state.phraseRequestId;
  const cached = state.phraseCache.get(normalized);
  if (cached) {
    state.phraseSuggestions = cached;
    state.selectedPhraseIndex = cached.length ? 0 : -1;
    renderPhraseSuggestions();
    return;
  }
  renderPhraseSuggestions(`Loading priority-ranked ideas for ${normalized}…`);
  try {
    const suggestions = await api(`/api/phrase-suggestions?letter=${encodeURIComponent(normalized)}&limit=8`);
    if (requestId !== state.phraseRequestId) return;
    state.phraseCache.set(normalized, suggestions);
    state.phraseSuggestions = suggestions;
    state.selectedPhraseIndex = suggestions.length ? 0 : -1;
    renderPhraseSuggestions();
  } catch (error) {
    if (requestId !== state.phraseRequestId) return;
    state.phraseSuggestions = [];
    renderPhraseSuggestions(`Phrase ideas could not be loaded: ${error.message}`);
  }
}

function renderPhraseSuggestions(status = null) {
  const list = $("#phrase-list");
  if (!list) return;
  const items = state.phraseSuggestions;
  const cameraActive = state.stream?.getVideoTracks().some((track) => track.readyState === "live");
  $("#phrase-status").textContent = status || (state.phraseMode === "offline"
    ? `${cameraActive ? "No stable letter is recognized yet." : "Camera is off."} Click a phrase to add it and speak it immediately, or use Add to sentence to add it silently.`
    : items.length
      ? `Priority-ranked ideas for letter ${state.phraseLetter}. Click a phrase to add and speak it immediately; custom phrases can be deleted.`
      : `No phrase ideas found for ${state.phraseLetter || "this letter"}.`);
  list.innerHTML = items.map((item, index) => `
    <div class="phrase-suggestion">
      <button class="phrase-option${index === state.selectedPhraseIndex ? " selected" : ""}"
        type="button" data-phrase-index="${index}" aria-pressed="${index === state.selectedPhraseIndex}">
        <span class="phrase-option-meta">${item.custom ? `Your phrase · ${escapeHtml(item.category)}` : `${escapeHtml(item.category)} · Priority ${item.priority}`}</span>
        <strong>${escapeHtml(item.english)}</strong>
        <span>${escapeHtml(item.hindi)}</span>
      </button>
      ${item.custom ? `<button class="phrase-delete" type="button" data-delete-phrase-id="${item.id}" aria-label="Delete custom phrase: ${escapeHtml(item.english)}" title="Delete custom phrase">×</button>` : ""}
    </div>`).join("");
  const hasSelection = state.selectedPhraseIndex >= 0 && state.selectedPhraseIndex < items.length;
  $("#phrase-prev").disabled = !hasSelection || state.selectedPhraseIndex === 0;
  $("#phrase-next").disabled = !hasSelection || state.selectedPhraseIndex >= items.length - 1;
  $("#phrase-add").disabled = !hasSelection;
  $("#phrase-use").disabled = !hasSelection;
}

function renderOfflineSuggestions() {
  state.phraseMode = "offline";
  state.phraseLetter = null;
  state.phraseSuggestions = [
    { category: "Quick phrase", priority: 1, english: "Please help me.", hindi: "कृपया मेरी मदद करें।" },
    { category: "Quick phrase", priority: 2, english: "Could you please call a doctor?", hindi: "क्या आप कृपया डॉक्टर को बुला सकते हैं?" },
    { category: "Quick phrase", priority: 3, english: "May I please have some water?", hindi: "क्या मुझे कृपया थोड़ा पानी मिल सकता है?" },
    { category: "Quick phrase", priority: 4, english: "Could you please call my family?", hindi: "क्या आप कृपया मेरे परिवार को बुला सकते हैं?" },
    { category: "Quick phrase", priority: 5, english: "I am feeling unwell. Could you please help me?", hindi: "मेरी तबीयत ठीक नहीं है। क्या आप कृपया मेरी मदद कर सकते हैं?" },
    { category: "Quick phrase", priority: 6, english: "Could you please assist me?", hindi: "क्या आप कृपया मेरी सहायता कर सकते हैं?" },
    { category: "Quick phrase", priority: 7, english: "Please give me a moment.", hindi: "कृपया मुझे थोड़ा समय दें।" }
  ];
  state.selectedPhraseIndex = 0;
  renderPhraseSuggestions();
}

function changePhraseSelection(direction) {
  const next = state.selectedPhraseIndex + direction;
  if (next < 0 || next >= state.phraseSuggestions.length) return;
  state.selectedPhraseIndex = next;
  renderPhraseSuggestions();
  $("#phrase-list").querySelector(`[data-phrase-index="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function selectedPhraseText(index) {
  const phrase = state.phraseSuggestions[index];
  if (!phrase) {
    toast("Select a phrase idea first.");
    return null;
  }
  const text = speechLanguage().toLowerCase().startsWith("hi") ? phrase.hindi : phrase.english;
  if (!text) {
    toast("The selected phrase is not available in that language.");
    return null;
  }
  state.selectedPhraseIndex = index;
  renderPhraseSuggestions();
  return text;
}

function addSelectedPhraseToSentence(index = state.selectedPhraseIndex) {
  const text = selectedPhraseText(index);
  if (!text) return;
  appendSentence(text);
  saveHistory("sign", text);
  toast("Phrase added to your sentence.");
}

function useSelectedPhrase(index = state.selectedPhraseIndex) {
  const text = selectedPhraseText(index);
  if (!text) return;
  appendSentence(text);
  speakSuggestedSentence(text);
  saveHistory("sign", text);
}

async function deleteCustomPhrase(phraseId) {
  const phrase = state.phraseSuggestions.find(
    (item) => item.custom && item.id === phraseId
  );
  if (!phrase) return toast("That custom phrase is no longer available.");
  if (!confirm(`Delete the custom phrase "${phrase.english}"?`)) return;
  try {
    await api(`/api/phrase-suggestions/${phraseId}`, { method: "DELETE" });
    state.phraseCache.delete(phrase.letter);
    state.phraseLetter = null;
    await updatePhraseSuggestions(phrase.letter);
    toast("Custom phrase deleted.");
  } catch (error) {
    toast(`Could not delete phrase: ${error.message}`);
  }
}

function activePageIs(id) {
  return $(`#page-${id}`)?.classList.contains("active") === true;
}

function cameraControlEnabled() {
  return (activePageIs("recognition") &&
      ($("#pointing-controls").checked || $("#gaze-controls").checked || $("#phrase-blink-controls").checked)) ||
    activePageIs("learning");
}

function detectDoubleBlink(result) {
  const now = performance.now();
  if (!result.face_detected) {
    state.blinkClosedAt = null;
    state.lastBlinkAt = null;
    return false;
  }
  const eyesClosed = bothEyesClosed(result);
  if (eyesClosed) {
    if (state.blinkClosedAt === null) state.blinkClosedAt = now;
    return false;
  }
  if (state.blinkClosedAt === null) return false;
  const closedDuration = now - state.blinkClosedAt;
  state.blinkClosedAt = null;
  if (closedDuration < 60 || closedDuration > 800 || now < state.blinkCooldownUntil) return false;
  if (state.lastBlinkAt !== null && now - state.lastBlinkAt <= 1400) {
    state.lastBlinkAt = null;
    state.blinkCooldownUntil = now + 2200;
    return true;
  }
  state.lastBlinkAt = now;
  return false;
}

function bothEyesClosed(result) {
  if (Array.isArray(result.eye_aspect_ratios) && result.eye_aspect_ratios.length === 2) {
    const threshold = state.eyeClosedThreshold ?? 0.19;
    return result.eye_aspect_ratios.every((ratio) => ratio <= threshold);
  }
  return Number.isFinite(result.eye_aspect_ratio) && state.eyeClosedThreshold !== null
    ? result.eye_aspect_ratio <= state.eyeClosedThreshold
    : result.eyes_closed === true;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function updateEyePractice(result) {
  const status = $("#eye-calibration-status");
  if (!status) return;
  const gaze = eyeGazeDirection(result.eye_gaze_x);
  const eyeState = bothEyesClosed(result) ? "both eyes closed" : "eyes open";
  status.textContent = result.face_detected
    ? `Face detected · ${eyeState} · gaze ${gaze || "center"} · eye ratio ${Number(result.eye_aspect_ratio).toFixed(3)}`
    : "Face not detected. Move into the camera view.";

  const capture = state.eyeCalibrationCapture;
  if (!capture) return;
  if (result.face_detected && Number.isFinite(result.eye_aspect_ratio)) {
    capture.ratios.push(result.eye_aspect_ratio);
    if (capture.kind === "open" && !bothEyesClosed(result) && Number.isFinite(result.eye_gaze_x)) {
      capture.gazeValues.push(result.eye_gaze_x);
    }
    status.textContent =
      `Capturing ${capture.kind === "open" ? "open-eye" : "closed-eye"} reading (${capture.ratios.length}/6)…`;
  } else {
    status.textContent = "Waiting for a clear face reading…";
  }
  if (capture.ratios.length >= 6) {
    finishEyeCalibrationCapture();
  } else if (performance.now() - capture.startedAt >= 4000) {
    finishEyeCalibrationCapture();
  }
}

function startEyeCalibrationCapture(kind) {
  if (!state.stream) return toast("Start the camera before calibrating eye detection.");
  state.eyeCalibrationCapture = { kind, ratios: [], gazeValues: [], startedAt: performance.now() };
  $("#eye-calibration-status").textContent = kind === "open"
    ? "Look at the camera with both eyes open while readings are captured…"
    : "Close your eyes comfortably while readings are captured…";
}

function finishEyeCalibrationCapture() {
  const capture = state.eyeCalibrationCapture;
  if (!capture) return;
  state.eyeCalibrationCapture = null;
  if (capture.ratios.length < 3) {
    $("#eye-calibration-status").textContent = "Not enough face readings. Check the lighting and try again.";
    return;
  }
  const ratio = median(capture.ratios);
  if (capture.kind === "open") {
    state.eyeOpenRatio = ratio;
    if (capture.gazeValues.length >= 3) state.eyeGazeCenter = median(capture.gazeValues);
  }
  else state.eyeClosedRatio = ratio;
  $("#eye-calibration-status").textContent =
    `${capture.kind === "open" ? "Open-eye" : "Closed-eye"} reading captured (${ratio.toFixed(3)}).`;

  const readings = [];
  if (state.eyeOpenRatio !== null) readings.push(`open ${state.eyeOpenRatio.toFixed(3)}`);
  if (state.eyeClosedRatio !== null) readings.push(`closed ${state.eyeClosedRatio.toFixed(3)}`);
  if (state.eyeOpenRatio !== null && state.eyeClosedRatio !== null) {
    if (state.eyeOpenRatio <= state.eyeClosedRatio + 0.03) {
      state.eyeClosedThreshold = null;
      $("#eye-calibration-result").textContent =
        "The readings are too close. Capture open and closed eyes again in steady lighting.";
    } else {
      state.eyeClosedThreshold = (state.eyeOpenRatio + state.eyeClosedRatio) / 2;
      state.blinkClosedAt = null;
      state.lastBlinkAt = null;
      $("#eye-calibration-result").textContent =
        `Personalized blink threshold active (${state.eyeClosedThreshold.toFixed(3)}). Readings: ${readings.join(", ")}.`;
    }
  } else {
    $("#eye-calibration-result").textContent =
      `Waiting for the other reading. Captured: ${readings.join(", ")}.`;
  }
  if (state.eyeGazeCenter !== null) {
    $("#eye-calibration-result").textContent +=
      ` Neutral gaze calibrated (${state.eyeGazeCenter.toFixed(3)}); look left/right to browse ideas.`;
  }
}

function resetEyeCalibration() {
  state.eyeOpenRatio = null;
  state.eyeClosedRatio = null;
  state.eyeClosedThreshold = null;
  state.eyeGazeCenter = null;
  state.eyeCalibrationCapture = null;
  state.blinkClosedAt = null;
  state.lastBlinkAt = null;
  $("#eye-calibration-status").textContent = state.stream
    ? "Calibration reset. Capture both eye positions to begin."
    : "Start the camera and face it to begin.";
  $("#eye-calibration-result").textContent =
    "Using standard blink detection until both readings are calibrated.";
}

function updateBlinkPracticeCount() {
  $("#blink-practice-count").textContent = `Double blinks detected: ${state.blinkPracticeCount}`;
}

function indexPointingX(result) {
  const points = result.hands?.[0]?.landmarks;
  if (!points || points.length < 21 || typeof points[8].z !== "number") return null;
  if (points[8].z >= points[6].z - 0.025) return null;
  const wrist = points[0];
  const distanceFromWrist = (index) => Math.hypot(
    points[index].x - wrist.x,
    points[index].y - wrist.y,
    points[index].z - wrist.z
  );
  const otherFingersFolded = [[12, 10], [16, 14], [20, 18]]
    .every(([tip, pip]) => distanceFromWrist(tip) < distanceFromWrist(pip) * 1.12);
  return otherFingersFolded ? points[8].x : null;
}

function detectPointSwipe(result) {
  const x = indexPointingX(result);
  if (x === null) {
    state.pointAnchorX = null;
    return null;
  }
  if (state.pointAnchorX === null) {
    state.pointAnchorX = x;
    return null;
  }
  const delta = x - state.pointAnchorX;
  if (Math.abs(delta) < 0.14 || performance.now() < state.pointCooldownUntil) return null;
  state.pointAnchorX = x;
  state.pointCooldownUntil = performance.now() + 900;
  return delta > 0 ? "left" : "right";
}

function eyeGazeDirection(gazeX) {
  if (!Number.isFinite(gazeX)) return null;
  const center = state.eyeGazeCenter ?? 0.5;
  if (gazeX >= center + 0.12) return "left";
  if (gazeX <= center - 0.12) return "right";
  return null;
}

function detectEyeGazeMovement(result) {
  if (!result.face_detected || bothEyesClosed(result)) return null;
  const direction = eyeGazeDirection(result.eye_gaze_x);
  if (!direction) {
    const center = state.eyeGazeCenter ?? 0.5;
    if (Number.isFinite(result.eye_gaze_x) &&
        result.eye_gaze_x > center - 0.06 && result.eye_gaze_x < center + 0.06) {
      state.gazeDirection = null;
    }
    return null;
  }
  if (direction === state.gazeDirection || performance.now() < state.gazeCooldownUntil) return null;
  state.gazeDirection = direction;
  state.gazeCooldownUntil = performance.now() + 700;
  return direction;
}

function handleOptInCameraControls(result) {
  if (detectDoubleBlink(result)) {
    if (activePageIs("learning")) {
      state.blinkPracticeCount++;
      updateBlinkPracticeCount();
    }
    if (activePageIs("learning") && $("#learning-blink-controls").checked) {
      void recordSample();
    } else if (activePageIs("recognition") && $("#phrase-blink-controls").checked &&
        state.phraseSuggestions.length) {
      useSelectedPhrase();
    }
  }
  const learningPractice = activePageIs("learning");
  if (activePageIs("recognition") && $("#gaze-controls").checked && state.phraseSuggestions.length) {
    const gazeDirection = detectEyeGazeMovement(result);
    if (gazeDirection) {
      changePhraseSelection(gazeDirection === "left" ? -1 : 1);
      return;
    }
  } else {
    state.gazeDirection = null;
  }
  const phraseNavigation = activePageIs("recognition") &&
    $("#pointing-controls").checked && state.phraseSuggestions.length;
  if (!learningPractice && !phraseNavigation) {
    state.pointAnchorX = null;
    return;
  }
  const direction = detectPointSwipe(result);
  if (!direction) {
    if (learningPractice) {
      $("#point-practice-status").textContent = !result.hands?.length
        ? "Waiting for a hand."
        : indexPointingX(result) === null
          ? "Point your index finger toward the camera with other fingers curled."
          : "Index point detected. Move your finger left or right.";
    }
    return;
  }
  if (learningPractice) {
    state.pointPracticeCounts[direction]++;
    $("#point-left-count").textContent = state.pointPracticeCounts.left;
    $("#point-right-count").textContent = state.pointPracticeCounts.right;
    $("#point-practice-status").textContent = `Swipe detected: ${direction}. Keep practicing in both directions.`;
    return;
  }
  changePhraseSelection(direction === "left" ? -1 : 1);
}

function appendSentence(word) {
  const field = $("#sentence-text");
  const current = field.value.trim();
  field.value = current ? `${current.replace(/[.!?]+$/, "")} ${word}` : word;
  updateSentenceCount();
}

function updateSentenceCount() {
  $("#sentence-count").textContent = `${$("#sentence-text").value.length} characters`;
}

async function savePhraseSuggestion(event) {
  event.preventDefault();
  const letter = $("#phrase-letter").value.trim().toUpperCase();
  const payload = {
    letter,
    category: $("#phrase-category").value.trim() || "Personal",
    english: $("#phrase-english").value.trim(),
    hindi: $("#phrase-hindi").value.trim()
  };
  try {
    const result = await api("/api/phrase-suggestions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.phraseCache.delete(letter);
    state.phraseLetter = null;
    await updatePhraseSuggestions(letter);
    $("#phrase-form").reset();
    $("#phrase-form").hidden = true;
    $("#phrase-add-toggle").textContent = "＋ Add phrase";
    toast(result.message);
  } catch (error) {
    toast(`Could not save phrase: ${error.message}`);
  }
}

async function createGesture(event) {
  event.preventDefault();
  try {
    const gesture = await api("/api/gestures", {
      method: "POST",
      body: JSON.stringify({
        label: $("#gesture-label").value.trim(),
        meaning: $("#gesture-meaning").value.trim(),
        language: $("#gesture-language").value,
        category: $("#gesture-category").value.trim() || "daily",
        kind: $("#gesture-kind").value
      })
    });
    $("#gesture-form").reset();
    toast(gesture.message);
    await loadGestures();
  } catch (error) { toast(error.message); }
}

async function recordSample() {
  const gestureId = Number($("#sample-gesture").value);
  const signerId = $("#signer-id").value.trim();
  if (!gestureId) return toast("Please select a gesture class first.");
  if (!signerId) return toast("Please enter a consistent contributor / signer ID.");
  const gesture = state.gestureClasses.find((item) => item.id === gestureId);
  if (!gesture) return toast("Selected gesture class was not found.");

  const targetHand = $("#sample-target-hand")?.value || "any";
  let chosenHand = state.allHands[0];
  if (targetHand === "Left") {
    chosenHand = state.allHands.find(h => h.handedness === "Left");
  } else if (targetHand === "Right") {
    chosenHand = state.allHands.find(h => h.handedness === "Right");
  } else if (targetHand === "Both" && state.allHands.length < 2) {
    return toast("Show both hands before recording this sample.");
  }

  const features = gesture.kind === "dynamic" ? state.sequence.slice(-20) : chosenHand?.features;
  if (!features || (gesture.kind === "dynamic" && features.length < 3)) {
    return toast(gesture.kind === "dynamic" ? "Record at least 3 frames of hand movement first." : "No hand landmarks are currently available.");
  }

  const handednessVal = targetHand === "Both" ? "any" : (chosenHand?.handedness || "any");

  try {
    const result = await api(`/api/gestures/${gestureId}/samples`, {
      method: "POST",
      body: JSON.stringify({
        features,
        signer_id: signerId,
        handedness: handednessVal === "Unknown" ? "any" : handednessVal,
        split: $("#sample-split").value
      })
    });
    toast(`Sample saved! ${gesture.label} now has ${result.sample_count} sample(s).`);
    await loadGestures();
  } catch (error) {
    toast(`Error recording sample: ${error.message}`);
  }
}

function updateReferencePhotoImportButton() {
  const gestureId = Number($("#sample-gesture").value);
  const gesture = state.gestureClasses.find((item) => item.id === gestureId);
  $("#import-reference-photos").disabled = !gesture?.reference_id || gesture.kind !== "static";
}

async function importReferencePhotos() {
  const gestureId = Number($("#sample-gesture").value);
  const gesture = state.gestureClasses.find((item) => item.id === gestureId);
  if (!gesture?.reference_id || gesture.kind !== "static") {
    return toast("Select a linked static gesture class first.");
  }
  try {
    const result = await api(`/api/gestures/${gestureId}/import-reference-photos`, {
      method: "POST",
      body: JSON.stringify({ reference_id: gesture.reference_id })
    });
    await loadGestures();
    const failure = result.failed[0]?.reason;
    toast(
      `${result.imported_count} photo sample(s) imported; ` +
      `${result.skipped_count} already imported.` +
      (failure ? ` First issue: ${failure}` : "")
    );
  } catch (error) {
    toast(`Could not import dictionary photos: ${error.message}`);
  }
}

let countdownTimer = null;
let countdownResetTimer = null;
function cancelRecordCountdown() {
  clearInterval(countdownTimer);
  clearTimeout(countdownResetTimer);
  countdownTimer = null;
  countdownResetTimer = null;
  if ($("#sample-countdown")) $("#sample-countdown").textContent = "";
  if ($("#record-countdown-btn")) {
    $("#record-countdown-btn").disabled = $("#record-sample")?.disabled !== false;
  }
}

function startRecordCountdown() {
  const cdEl = $("#sample-countdown");
  const btn = $("#record-countdown-btn");
  if (!cdEl || !btn || btn.disabled || countdownTimer) return;
  let sec = 3;
  btn.disabled = true;
  cdEl.textContent = `Recording in ${sec}s...`;
  countdownTimer = setInterval(() => {
    sec--;
    if (sec > 0) {
      cdEl.textContent = `Recording in ${sec}s...`;
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      cdEl.textContent = "📸 Captured!";
      void recordSample();
      countdownResetTimer = setTimeout(() => {
        cdEl.textContent = "";
        btn.disabled = $("#record-sample")?.disabled !== false;
        countdownResetTimer = null;
      }, 1500);
    }
  }, 1000);
}

async function loadGestures() {
  try {
    const gestures = await api("/api/gestures");
    state.gestureClasses = gestures;
    renderGestures(gestures);
  } catch (error) { toast(error.message); }
}

function renderGestures(gestures) {
  const tbody = $("#gesture-table");
  const selector = $("#sample-gesture");
  const previous = selector.value;
  selector.innerHTML = '<option value="">Select a class</option>' + gestures.map((item) =>
    `<option value="${item.id}">${escapeHtml(item.label)} — ${escapeHtml(item.meaning)} (${item.kind})</option>`
  ).join("");
  if (gestures.some((item) => String(item.id) === previous)) selector.value = previous;
  tbody.innerHTML = gestures.length ? gestures.map((item) => `
    <tr><td><strong>${escapeHtml(item.label)}</strong><br><span class="muted">${escapeHtml(item.meaning)}</span></td>
    <td>${escapeHtml(item.kind)}</td><td>${item.sample_count}</td>
    <td>${item.train_count} / ${item.validation_count}</td><td>${item.signer_count}</td>
    <td><span class="table-status ${item.ready ? "ready" : "collecting"}">${escapeHtml(gestureDatasetStatus(item))}</span></td>
    <td><button class="table-action" data-delete-gesture="${item.id}" aria-label="Delete ${escapeHtml(item.label)}">Delete</button></td></tr>`
  ).join("") : '<tr><td colspan="7" class="empty-state">No gesture classes collected yet.</td></tr>';
  const dictionary = $("#dictionary-grid");
  if (dictionary) {
    const search = ($("#dictionary-search")?.value || "").toLowerCase();
    const visible = gestures.filter((item) => `${item.label} ${item.meaning} ${item.category}`.toLowerCase().includes(search));
    $("#dictionary-count").textContent = `${visible.length} gesture${visible.length === 1 ? "" : "s"}`;
    dictionary.innerHTML = visible.length ? visible.map((item) => `
      <article class="dictionary-item"><span class="tag">${escapeHtml(item.category)} · ${escapeHtml(item.kind)}</span>
        <h2>${escapeHtml(item.label)}</h2><p>${escapeHtml(item.meaning)}</p>
        <small>${item.ready ? "Validated for local recognition" : `${item.sample_count} samples · collecting examples`}</small></article>`
    ).join("") : '<p class="empty-state">No matching gesture classes.</p>';
  }
  $("#stat-gestures").textContent = gestures.length;
  $("#stat-ready").textContent = gestures.filter((item) => item.ready).length;
  updateReferencePhotoImportButton();
  $$("[data-delete-gesture]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this gesture and all its samples?")) return;
    try { await api(`/api/gestures/${button.dataset.deleteGesture}`, { method: "DELETE" }); await loadGestures(); }
    catch (error) { toast(error.message); }
  }));
}

function gestureDatasetStatus(item) {
  if (item.ready) return "Dataset complete";
  const missing = [];
  if (item.train_count < 8) missing.push(`${8 - item.train_count} training`);
  if (item.validation_count < 2) missing.push(`${2 - item.validation_count} validation`);
  if (item.signer_count < 2) missing.push("1 more contributor");
  const status = item.train_count > 0
    ? "Training samples match live · missing "
    : "No training examples · missing ";
  return `${status}${missing.join(", ")}`;
}

async function loadHistory(query = "") {
  try {
    const items = await api(`/api/history?query=${encodeURIComponent(query)}`);
    state.history = items;
    $("#history-count").textContent = `${items.length} saved`;
    $("#history-list").innerHTML = items.length ? items.map((item) => `
      <article class="history-item"><span class="history-mode">${item.mode === "speech" ? "♫" : item.mode === "emergency" ? "✚" : "◉"}</span>
        <div class="history-content"><strong>${escapeHtml(item.text)}</strong><small>${escapeHtml(item.mode)} · ${formatDate(item.created_at)}${item.confidence == null ? "" : ` · ${Math.round(item.confidence * 100)}% similarity`}</small></div>
        <button data-delete-history="${item.id}" aria-label="Delete conversation">Delete</button></article>`
    ).join("") : '<p class="empty-state">No saved conversations found.</p>';
    $$("[data-delete-history]").forEach((button) => button.addEventListener("click", async () => {
      try { await api(`/api/history/${button.dataset.deleteHistory}`, { method: "DELETE" }); await loadHistory($("#history-search").value); await refreshStats(); }
      catch (error) { toast(error.message); }
    }));
  } catch (error) { toast(error.message); }
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#speech-support").textContent = "Speech recognition is not available in this browser. Try a supported Chromium-based browser.";
    $("#speech-start").disabled = true;
    return;
  }
  $("#speech-support").textContent = "Browser speech recognition is ready. Microphone permission is required.";
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  state.recognition = recognition;
  recognition.onstart = () => { $("#speech-start").disabled = true; $("#speech-stop").disabled = false; };
  recognition.onend = () => { $("#speech-start").disabled = false; $("#speech-stop").disabled = true; };
  recognition.onerror = (event) => {
    $("#speech-support").textContent = event.error === "not-allowed"
      ? "Microphone permission was denied. Allow access in browser settings."
      : `Speech recognition error: ${event.error}`;
  };
  recognition.onresult = (event) => {
    let interim = "";
    let finals = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript;
      if (event.results[index].isFinal) finals += transcript;
      else interim += transcript;
    }
    $("#caption-output").textContent = `${finals} ${interim}`.trim() || "Listening…";
    if (finals.trim()) {
      $("#caption-transcript").value += `${$("#caption-transcript").value ? " " : ""}${finals.trim()}`;
      saveHistory("speech", finals.trim());
    }
  };
}

function renderEmergencyPhrases() {
  const phrases = [...defaultPhrases, ...state.customPhrases];
  $("#emergency-grid").innerHTML = phrases.map((phrase, index) => `
    <button class="emergency-card" data-emergency-index="${index}"><span>QUICK PHRASE ${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(phrase)}</strong></button>`
  ).join("");
  $$("[data-emergency-index]").forEach((button) => button.addEventListener("click", () => {
    state.selectedEmergency = phrases[Number(button.dataset.emergencyIndex)];
    $$(".emergency-card").forEach((card) => card.classList.toggle("selected", card === button));
    $("#emergency-text").textContent = state.selectedEmergency;
    $("#emergency-speak").disabled = false;
  }));
}

function toggleTheme() {
  document.body.classList.toggle("dark-theme");
  localStorage.setItem("signbridge-theme", document.body.classList.contains("dark-theme") ? "dark" : "light");
}

function setupEvents() {
  $$(".nav-link").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$("[data-go]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
  $("#camera-start").addEventListener("click", startCamera);
  $("#camera-stop").addEventListener("click", stopCamera);
  $("#gesture-form").addEventListener("submit", createGesture);
  $("#record-sample").addEventListener("click", recordSample);
  $("#sample-gesture").addEventListener("change", updateReferencePhotoImportButton);
  $("#import-reference-photos").addEventListener("click", importReferencePhotos);
  $("#refresh-gestures").addEventListener("click", loadGestures);
  $("#dictionary-search").addEventListener("input", () => renderGestures(state.gestureClasses));
  $("#history-search").addEventListener("input", (event) => loadHistory(event.target.value));
  $("#sentence-text").addEventListener("input", updateSentenceCount);
  $("#clear-sentence").addEventListener("click", () => { $("#sentence-text").value = ""; updateSentenceCount(); });
  $("#copy-sentence").addEventListener("click", async () => {
    if (!$("#sentence-text").value.trim()) return toast("There is no sentence to copy.");
    try { await navigator.clipboard.writeText($("#sentence-text").value); toast("Sentence copied."); }
    catch { toast("Clipboard access is unavailable. Select and copy the sentence manually."); }
  });
  $("#speak-sentence").addEventListener("click", () => speak($("#sentence-text").value));
  $("#pause-speech").addEventListener("click", toggleSpeechPause);
  $("#replay-speech").addEventListener("click", () => speak($("#sentence-text").value));
  $("#save-sentence").addEventListener("click", () => saveHistory("sign", $("#sentence-text").value));
  $("#phrase-prev").addEventListener("click", () => changePhraseSelection(-1));
  $("#phrase-next").addEventListener("click", () => changePhraseSelection(1));
  $("#phrase-add-toggle").addEventListener("click", () => {
    const form = $("#phrase-form");
    form.hidden = !form.hidden;
    $("#phrase-add-toggle").textContent = form.hidden ? "＋ Add phrase" : "Cancel";
    if (!form.hidden) {
      $("#phrase-letter").value = state.formedLetter || "";
      $("#phrase-english").focus();
    }
  });
  $("#phrase-cancel").addEventListener("click", () => {
    $("#phrase-form").reset();
    $("#phrase-form").hidden = true;
    $("#phrase-add-toggle").textContent = "＋ Add phrase";
  });
  $("#phrase-letter").addEventListener("input", (event) => {
    event.target.value = event.target.value.toUpperCase();
  });
  $("#phrase-form").addEventListener("submit", savePhraseSuggestion);
  $("#phrase-add").addEventListener("click", () => addSelectedPhraseToSentence());
  $("#phrase-use").addEventListener("click", useSelectedPhrase);
  $("#phrase-list").addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-phrase-id]");
    if (deleteButton) {
      deleteCustomPhrase(Number(deleteButton.dataset.deletePhraseId));
      return;
    }
    const option = event.target.closest("[data-phrase-index]");
    if (!option) return;
    useSelectedPhrase(Number(option.dataset.phraseIndex));
  });
  $("#clear-recognized-letter").addEventListener("click", clearRecognizedLetter);
  $("#pointing-controls").addEventListener("change", () => { state.pointAnchorX = null; });
  $("#gaze-controls").addEventListener("change", () => {
    state.gazeDirection = null;
    state.gazeCooldownUntil = 0;
  });
  $("#phrase-blink-controls").addEventListener("change", () => {
    state.lastBlinkAt = null;
    state.blinkClosedAt = null;
  });
  $("#speech-start").addEventListener("click", () => {
    state.recognition.lang = speechLanguage();
    try { state.recognition.start(); } catch (error) { toast(`Could not start microphone: ${error.message}`); }
  });
  $("#speech-stop").addEventListener("click", () => state.recognition?.stop());
  $("#save-caption").addEventListener("click", () => saveHistory("speech", $("#caption-transcript").value));
  $("#emergency-speak").addEventListener("click", () => {
    speak(state.selectedEmergency);
    saveHistory("emergency", state.selectedEmergency);
  });
  $("#custom-phrase-button").addEventListener("click", () => {
    const phrase = prompt("Enter a custom emergency phrase:");
    if (phrase?.trim()) {
      state.customPhrases.push(phrase.trim());
      localStorage.setItem("signbridge-custom-phrases", JSON.stringify(state.customPhrases));
      renderEmergencyPhrases();
    }
  });
  $("#clear-history").addEventListener("click", async () => {
    if (!confirm("Permanently clear all saved conversations on this device?")) return;
    try { await api("/api/history", { method: "DELETE" }); await loadHistory(); await refreshStats(); }
    catch (error) { toast(error.message); }
  });
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#settings-theme").addEventListener("click", toggleTheme);
  $("#speech-language").addEventListener("change", (event) => { $("#settings-language").value = event.target.value; });
  $("#settings-language").addEventListener("change", (event) => { $("#speech-language").value = event.target.value; });
  document.addEventListener("keydown", (event) => {
    if (!activePageIs("recognition") || !state.phraseSuggestions.length) return;
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement?.tagName)) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); changePhraseSelection(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); changePhraseSelection(1); }
    if (event.key === "Enter" && $("#phrase-use").disabled === false) {
      event.preventDefault();
      useSelectedPhrase();
    }
  });

  // AI Learning mode camera & countdown
  $("#learning-camera-start")?.addEventListener("click", startCamera);
  $("#learning-camera-stop")?.addEventListener("click", stopCamera);
  $("#record-countdown-btn")?.addEventListener("click", startRecordCountdown);
  $("#learning-blink-controls")?.addEventListener("change", () => {
    state.lastBlinkAt = null;
    state.blinkClosedAt = null;
  });
  $("#calibrate-eyes-open")?.addEventListener("click", () => startEyeCalibrationCapture("open"));
  $("#calibrate-eyes-closed")?.addEventListener("click", () => startEyeCalibrationCapture("closed"));
  $("#reset-eye-calibration")?.addEventListener("click", resetEyeCalibration);
  $("#sample-target-hand")?.addEventListener("change", () => {
    const targetHand = $("#sample-target-hand")?.value || "any";
    const handCount = state.allHands.length;
    let ready = false;
    if (handCount > 0) {
      if (targetHand === "any") ready = true;
      else if (targetHand === "Both") ready = handCount >= 2;
      else ready = state.allHands.some(h => h.handedness === targetHand);
    }
    if ($("#record-sample")) $("#record-sample").disabled = !ready;
    if ($("#record-countdown-btn") && !countdownTimer && !countdownResetTimer) {
      $("#record-countdown-btn").disabled = !ready;
    }
  });

  // ISL Reference Add/Edit/Reset
  $("#isl-add-gesture-btn")?.addEventListener("click", () => openIslEditModal(null));
  $("#isl-reset-btn")?.addEventListener("click", resetIslDefaults);
  $("#isl-edit-modal-close")?.addEventListener("click", closeIslEditModal);
  $("#isl-edit-cancel")?.addEventListener("click", closeIslEditModal);
  $("#isl-edit-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeIslEditModal();
  });
  $("#isl-gesture-form")?.addEventListener("submit", saveIslGesture);
}

document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("signbridge-theme") === "dark") document.body.classList.add("dark-theme");
  try {
    const savedPhrases = JSON.parse(localStorage.getItem("signbridge-custom-phrases") || "[]");
    if (Array.isArray(savedPhrases)) state.customPhrases = savedPhrases.filter((phrase) => typeof phrase === "string");
  } catch (error) {
    toast(`Could not load custom phrases: ${error.message}`);
  }
  setupEvents();
  setupSpeechRecognition();
  renderEmergencyPhrases();
  refreshStats();
  updateSentenceCount();
  renderOfflineSuggestions();
  // Load dynamic public ISL reference from database
  loadIslReference();
});
window.addEventListener("beforeunload", stopCamera);

// ─── ISL Reference Dictionary (Public & Dynamic) ─────────────────────────────

let ISL_REFERENCE = [];
let GESTURE_GUIDES = null;
const islState = { activeCategory: "All", filtered: [] };
let islCurrentViewingId = null;

async function loadIslReference() {
  try {
    const data = await api("/api/isl-reference");
    try {
      GESTURE_GUIDES = await api("/api/gesture-guides");
    } catch (error) {
      GESTURE_GUIDES = null;
      console.error("Could not load alphabet and number guide files:", error);
      toast(`Could not load alphabet/number instructions: ${error.message}`);
    }
    if (Array.isArray(data)) {
      ISL_REFERENCE = data.map((gesture) => {
        const source = gesture.category === "Alphabet"
          ? GESTURE_GUIDES?.alphabet
          : gesture.category === "Number"
            ? GESTURE_GUIDES?.number
            : null;
        if (!["Alphabet", "Number"].includes(gesture.category)) return gesture;
        const guideSteps = source?.gestures?.[gesture.label] || [];
        return {
          ...gesture,
          steps: [
            ...(source?.general ? [`General guidance: ${source.general}`] : []),
            ...(gesture.category === "Number" && Number(gesture.label) >= 6 && source?.two_hand_rule
              ? [source.two_hand_rule]
              : []),
            ...guideSteps
          ],
          tip: ""
        };
      });
    }
  } catch (err) {
    console.error("Could not load gesture guides and ISL reference:", err);
    toast(`Could not load gesture guides: ${err.message}`);
  }
  renderIslCategories();
  renderIslGrid();
  // Update other components that rely on ISL reference
  if (typeof glBuildDeck === "function" && typeof glRenderCard === "function") {
    glBuildDeck(glState.activeCategory || "All");
    glRenderCard();
    if (typeof glRenderStrip === "function") glRenderStrip();
    if (typeof glRenderPills === "function") glRenderPills();
  }
  renderDictContent();
}

function renderIslCategories() {
  const container = $("#isl-category-pills");
  if (!container) return;
  const categories = ["All", ...new Set(ISL_REFERENCE.map((g) => g.category || "Common"))];
  container.innerHTML = categories.map((cat) =>
    `<button class="isl-pill ${cat === islState.activeCategory ? "active" : ""}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
  ).join("");
  container.querySelectorAll(".isl-pill").forEach((btn) => btn.addEventListener("click", () => {
    islState.activeCategory = btn.dataset.cat;
    $$(".isl-pill").forEach((b) => b.classList.toggle("active", b === btn));
    renderIslGrid();
  }));
}

function renderIslGrid() {
  const search = ($("#isl-search")?.value || "").toLowerCase();
  const filtered = ISL_REFERENCE.filter((g) => {
    const matchCat = islState.activeCategory === "All" || g.category === islState.activeCategory;
    const matchSearch = !search || `${g.label} ${g.meaning} ${g.hindi || ''} ${g.category}`.toLowerCase().includes(search);
    return matchCat && matchSearch;
  });
  islState.filtered = filtered;
  const grid = $("#isl-grid");
  if (!grid) return;
  $("#isl-count").textContent = `${filtered.length} gesture${filtered.length === 1 ? "" : "s"}`;
  grid.innerHTML = filtered.length ? filtered.map((g) => `
    <article class="isl-card" data-isl-id="${g.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        ${g.photos?.length
          ? `<img class="isl-card-photo" src="${escapeHtml(g.photos[0].url)}" alt="${escapeHtml(g.label)} gesture reference" loading="lazy">`
          : `<span class="isl-symbol">${escapeHtml(g.symbol || "✋")}</span>`}
        <span class="isl-cat-tag">${escapeHtml(g.category || "Common")} · ${escapeHtml(g.kind || "static")}</span>
      </div>
      <div class="isl-card-meta">
        <h3>${escapeHtml(g.label)}</h3>
        <p>${escapeHtml(g.meaning)}</p>
        <small>${escapeHtml(g.hindi || "")}</small>
      </div>
      <div class="isl-card-actions">
        <button class="isl-btn-action" data-isl-view="${g.id}">📖 Guide</button>
        <div class="isl-card-actions-left">
          <button class="isl-btn-action" data-isl-edit="${g.id}" title="Edit this gesture">✏️ Edit</button>
          <button class="isl-btn-action delete" data-isl-delete="${g.id}" title="Delete gesture">🗑️</button>
        </div>
      </div>
    </article>`).join("") : '<p class="empty-state">No gestures match your search.</p>';

  // Attach card event listeners
  $$("[data-isl-view]").forEach((btn) => btn.addEventListener("click", () => openIslModal(btn.dataset.islView)));
  $$("[data-isl-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const g = ISL_REFERENCE.find((item) => item.id === btn.dataset.islEdit);
    if (g) openIslEditModal(g);
  }));
  $$("[data-isl-delete]").forEach((btn) => btn.addEventListener("click", () => deleteIslGesture(btn.dataset.islDelete)));
}

function openIslModal(id) {
  const gesture = ISL_REFERENCE.find((g) => g.id === id);
  if (!gesture) return;
  islCurrentViewingId = id;
  $("#isl-modal-symbol").textContent = gesture.symbol || "✋";
  $("#isl-modal-title").textContent = gesture.label;
  $("#isl-modal-tag").textContent = `${gesture.category || 'Common'} · ${gesture.kind || 'static'}`;
  $("#isl-modal-meaning").textContent = gesture.meaning;
  $("#isl-modal-hindi").textContent = gesture.hindi || "";
  const photoSection = $("#isl-modal-photo-section");
  const photoGrid = $("#isl-modal-photos");
  photoSection.hidden = !gesture.photos?.length;
  photoGrid.innerHTML = (gesture.photos || []).map((photo) =>
    `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(gesture.label)} gesture reference" loading="lazy">`
  ).join("");
  const stepsList = Array.isArray(gesture.steps) ? gesture.steps : [];
  $("#isl-modal-steps").innerHTML = stepsList.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  const tipSection = $("#isl-tips-section");
  const tipEl = $("#isl-modal-tip");
  if (gesture.tip) { tipEl.textContent = gesture.tip; tipSection.hidden = false; }
  else { tipSection.hidden = true; }
  const overlay = $("#isl-modal-overlay");
  if (overlay) {
    overlay.hidden = false;
    overlay.style.display = "grid";
    overlay.onclick = (e) => { if (e.target === overlay) closeIslModal(); };
  }
  document.body.style.overflow = "hidden";
  if ($("#isl-modal-close")) {
    $("#isl-modal-close").onclick = closeIslModal;
    $("#isl-modal-close").focus();
  }

  $("#isl-speak-meaning").onclick = () => speak(gesture.meaning);
  $("#isl-go-learn").onclick = () => startReferenceTraining(gesture.id);
  if ($("#isl-modal-edit-btn")) {
    $("#isl-modal-edit-btn").onclick = () => {
      closeIslModal();
      openIslEditModal(gesture);
    };
  }
}

function closeIslModal() {
  const overlay = $("#isl-modal-overlay");
  if (overlay) {
    overlay.hidden = true;
    overlay.style.display = "none";
  }
  document.body.style.overflow = "";
}

function openIslEditModal(gesture = null) {
  const overlay = $("#isl-edit-modal-overlay");
  if (!overlay) return;
  if (gesture) {
    $("#isl-edit-modal-title").textContent = `Edit "${gesture.label}" Gesture`;
    $("#isl-edit-id").value = gesture.id;
    $("#isl-edit-label").value = gesture.label;
    $("#isl-edit-symbol").value = gesture.symbol || "✋";
    $("#isl-edit-meaning").value = gesture.meaning;
    $("#isl-edit-hindi").value = gesture.hindi || "";
    $("#isl-edit-category").value = gesture.category || "Common";
    $("#isl-edit-kind").value = gesture.kind || "static";
    const steps = Array.isArray(gesture.steps) ? gesture.steps.join("\n") : "";
    $("#isl-edit-steps").value = steps;
    $("#isl-edit-tip").value = gesture.tip || "";
    renderEditablePhotos(gesture);
  } else {
    $("#isl-edit-modal-title").textContent = "Add New ISL Gesture";
    $("#isl-edit-id").value = "";
    $("#isl-gesture-form").reset();
    $("#isl-edit-symbol").value = "✋";
    $("#isl-edit-photos").innerHTML = '<p class="muted small">Save the gesture first to add photos.</p>';
  }
  $("#isl-edit-photos-input").value = "";
  overlay.hidden = false;
  overlay.style.display = "grid";
  overlay.onclick = (e) => { if (e.target === overlay) closeIslEditModal(); };
  document.body.style.overflow = "hidden";
  if ($("#isl-edit-modal-close")) $("#isl-edit-modal-close").onclick = closeIslEditModal;
  if ($("#isl-edit-cancel")) $("#isl-edit-cancel").onclick = closeIslEditModal;
  $("#isl-edit-label").focus();
}

function renderEditablePhotos(gesture) {
  const container = $("#isl-edit-photos");
  const photos = gesture.photos || [];
  container.innerHTML = photos.length ? photos.map((photo) => `
    <div class="isl-photo-item">
      <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(gesture.label)} reference photo" loading="lazy">
      <button type="button" class="button button-quiet" data-delete-isl-photo="${photo.id}" aria-label="Delete gesture photo">Remove</button>
    </div>`).join("") : '<p class="muted small">No reference photos saved yet.</p>';
  $$("[data-delete-isl-photo]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/isl-reference/${encodeURIComponent(gesture.id)}/images/${button.dataset.deleteIslPhoto}`, { method: "DELETE" });
      gesture.photos = gesture.photos.filter((photo) => String(photo.id) !== button.dataset.deleteIslPhoto);
      renderEditablePhotos(gesture);
      toast("Gesture photo removed.");
    } catch (error) {
      toast(`Could not remove photo: ${error.message}`);
    }
  }));
}

function closeIslEditModal() {
  const overlay = $("#isl-edit-modal-overlay");
  if (overlay) {
    overlay.hidden = true;
    overlay.style.display = "none";
  }
  document.body.style.overflow = "";
}

window.closeIslModal = closeIslModal;
window.closeIslEditModal = closeIslEditModal;
window.openIslEditModal = openIslEditModal;

async function saveIslGesture(event) {
  event.preventDefault();
  const id = $("#isl-edit-id").value.trim();
  const label = $("#isl-edit-label").value.trim();
  const symbol = $("#isl-edit-symbol").value.trim() || "✋";
  const meaning = $("#isl-edit-meaning").value.trim();
  const hindi = $("#isl-edit-hindi").value.trim();
  const category = $("#isl-edit-category").value;
  const kind = $("#isl-edit-kind").value;
  const stepsRaw = $("#isl-edit-steps").value.split("\n").map(s => s.trim()).filter(Boolean);
  const tip = $("#isl-edit-tip").value.trim();

  if (!label || !meaning) return toast("Label and meaning are required.");

  const payload = { symbol, category, label, meaning, hindi, kind, steps: stepsRaw, tip };
  const files = [...$("#isl-edit-photos-input").files];
  if (files.length > 12) return toast("Choose no more than 12 photos at a time.");
  for (const file of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return toast(`${file.name}: choose a JPEG, PNG, or WebP photo.`);
    }
    if (file.size > 4 * 1024 * 1024) {
      return toast(`${file.name}: each photo must be smaller than 4 MB.`);
    }
  }

  try {
    let savedId = id;
    if (id) {
      await api(`/api/isl-reference/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      toast(`Gesture "${label}" updated successfully!`);
    } else {
      const saved = await api("/api/isl-reference", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      savedId = saved.id;
      $("#isl-edit-id").value = savedId;
      $("#isl-edit-modal-title").textContent = `Edit "${label}" Gesture`;
    }
    const existing = ISL_REFERENCE.find((gesture) => gesture.id === savedId);
    if ((existing?.photos?.length || 0) + files.length > 12) {
      return toast("A gesture can have at most 12 reference photos.");
    }
    for (const file of files) {
      const imageData = await readFileAsDataUrl(file);
      await api(`/api/isl-reference/${encodeURIComponent(savedId)}/images`, {
        method: "POST",
        body: JSON.stringify({ image_data: imageData })
      });
    }
    if (files.length) toast(`${files.length} gesture photo${files.length === 1 ? "" : "s"} saved.`);
    closeIslEditModal();
    await loadIslReference();
    await loadGestures();
  } catch (error) {
    $("#isl-edit-photos-input").value = "";
    await loadIslReference();
    const savedGesture = ISL_REFERENCE.find((gesture) => gesture.id === $("#isl-edit-id").value);
    if (savedGesture) renderEditablePhotos(savedGesture);
    toast(`Error saving gesture: ${error.message}`);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function startReferenceTraining(referenceId) {
  const reference = ISL_REFERENCE.find((item) => item.id === referenceId);
  if (!reference) return toast("That dictionary gesture could not be found.");
  try {
    const trainingClass = await api("/api/gestures", {
      method: "POST",
      body: JSON.stringify({
        label: reference.label,
        meaning: reference.meaning,
        language: "en",
        category: reference.category.toLowerCase(),
        kind: reference.kind,
        reference_id: reference.id
      })
    });
    closeIslModal();
    closeIslEditModal();
    navigate("learning");
    await loadGestures();
    $("#sample-gesture").value = String(trainingClass.id);
    $("#gesture-label").value = reference.label;
    $("#gesture-meaning").value = reference.meaning;
    $("#gesture-language").value = "en";
    $("#gesture-category").value = reference.category.toLowerCase();
    $("#gesture-kind").value = reference.kind;
    $("#sample-gesture").scrollIntoView({ behavior: "smooth", block: "center" });
    toast(`Ready to train "${reference.label}". Record training and validation samples with the camera.`);
  } catch (error) {
    toast(`Could not open gesture training: ${error.message}`);
  }
}

async function deleteIslGesture(id) {
  const g = ISL_REFERENCE.find((item) => item.id === id);
  const name = g ? g.label : "this gesture";
  if (!confirm(`Are you sure you want to delete "${name}" from the public ISL Reference?`)) return;

  try {
    await api(`/api/isl-reference/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`Gesture "${name}" deleted.`);
    await loadIslReference();
  } catch (error) {
    toast(`Error deleting gesture: ${error.message}`);
  }
}

async function resetIslDefaults() {
  if (!confirm("Are you sure you want to reset the ISL Reference to the standard 64 gestures? Any custom gestures will be replaced.")) return;
  try {
    const res = await api("/api/isl-reference/reset", { method: "POST" });
    toast(res.message || "Reset completed.");
    await loadIslReference();
  } catch (error) {
    toast(`Error resetting: ${error.message}`);
  }
}

function setupIslReference() {
  closeIslModal();
  closeIslEditModal();
  if (!$("#isl-grid")) return;
  loadIslReference();
  $("#isl-search")?.addEventListener("input", renderIslGrid);
  $("#isl-modal-close")?.addEventListener("click", closeIslModal);
  $("#isl-modal-overlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeIslModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#isl-modal-overlay")?.hidden) closeIslModal();
      if (!$("#isl-edit-modal-overlay")?.hidden) closeIslEditModal();
    }
  });
}

// Patch navigate to also trigger ISL setup
window._navigateToIsl = () => setupIslReference();

// ─── Gesture Learning Page ───────────────────────────────────────────────────

const GL_COLORS = {
  Alphabet: { bg:'#e8ecff', border:'#c5ceff', accent:'#5368df', light:'#f0f3ff' },
  Number:   { bg:'#e8f7ef', border:'#b8e8d2', accent:'#26845b', light:'#f0fbf5' },
  Greeting: { bg:'#fff4df', border:'#f0dba0', accent:'#ae7d2c', light:'#fffae8' },
  Common:   { bg:'#f4e8ff', border:'#d8b8f8', accent:'#8e70d8', light:'#faf0ff' }
};
function glColor(cat){ return GL_COLORS[cat] || GL_COLORS.Common; }

const glState = {
  deck:[], index:0, flipped:false, quizMode:false,
  autoplay:false, autoTimer:null,
  score:{ correct:0, wrong:0, total:0 },
  activeCategory:'All', ready:false
};

function glBuildDeck(cat){
  const activeId = glState.deck[glState.index]?.id;
  glState.activeCategory = cat;
  glState.deck = cat==='All' ? [...ISL_REFERENCE]
    : ISL_REFERENCE.filter(g=>g.category===cat);
  const activeIndex = glState.deck.findIndex(g=>g.id === activeId);
  glState.index = activeIndex >= 0 ? activeIndex : 0;
}

function glQ(id){ return document.getElementById(id); }

function glRenderCard(){
  const g = glState.deck[glState.index];
  if(!g) return;
  const col = glColor(g.category);

  /* ---- FRONT ---- */
  glState.flipped = false;
  const front = glQ('gl-front'), back = glQ('gl-back');
  if(front) front.hidden = false;
  if(back)  back.hidden  = true;

  const vis = glQ('gl-visual');
  if(vis){
    vis.style.background   = col.bg;
    vis.style.borderColor  = col.border;
  }
  const emojiEl = glQ('gl-emoji');
  const photoEl = glQ('gl-photo');
  const photoUrl = g.photos?.[0]?.url;
  if(emojiEl) {
    const useLabel = !photoUrl && ['Alphabet', 'Number'].includes(g.category);
    emojiEl.textContent = useLabel ? g.label : g.symbol;
    emojiEl.classList.toggle('gl-text-placeholder', useLabel);
    emojiEl.hidden = Boolean(photoUrl);
  }
  if(photoEl) {
    photoEl.hidden = !photoUrl;
    photoEl.src = photoUrl || "";
    photoEl.alt = `${g.label} gesture reference`;
  }

  const kindTag = glQ('gl-kind-tag');
  if(kindTag){
    kindTag.textContent = g.kind === 'dynamic' ? 'Dynamic' : 'Static';
    kindTag.style.background = col.accent;
  }
  const step0 = glQ('gl-step0');
  if(step0) step0.textContent = g.steps[0] || '';

  const catPill = glQ('gl-cat-pill');
  if(catPill){ catPill.textContent = g.category; catPill.style.color=col.accent; catPill.style.background=col.light; }

  const lbl = glQ('gl-label');
  if(lbl) lbl.textContent = g.label;

  const hint = glQ('gl-meaning-hint');
  if(hint) hint.textContent = g.meaning;

  /* ---- BACK ---- */
  const beEl = glQ('gl-back-emoji');
  if(beEl) {
    beEl.textContent = g.symbol;
    beEl.hidden = Boolean(photoUrl);
  }
  const backPhotoEl = glQ('gl-back-photo');
  if(backPhotoEl) {
    backPhotoEl.hidden = !photoUrl;
    backPhotoEl.src = photoUrl || "";
    backPhotoEl.alt = `${g.label} gesture reference`;
  }
  const blEl = glQ('gl-back-label');
  if(blEl) blEl.textContent = g.label;
  const bcEl = glQ('gl-back-cat');
  if(bcEl){ bcEl.textContent = g.category+' · '+g.kind; bcEl.style.color=col.accent; bcEl.style.background=col.light; }
  const bmEl = glQ('gl-back-meaning');
  if(bmEl) bmEl.textContent = g.meaning;
  const bhEl = glQ('gl-back-hindi');
  if(bhEl) bhEl.textContent = g.hindi;

  const stepsEl = glQ('gl-back-steps');
  if(stepsEl) stepsEl.innerHTML = g.steps.map((s,i)=>
    `<li><span class="gl-step-num" style="background:${col.accent}">${i+1}</span><span>${escapeHtml(s)}</span></li>`
  ).join('');

  const tipEl = glQ('gl-tip');
  const tipTxt = glQ('gl-tip-text');
  if(tipEl && tipTxt){
    if(g.tip){ tipTxt.textContent=g.tip; tipEl.hidden=false; }
    else { tipEl.hidden=true; }
  }

  const qbtns = glQ('gl-quiz-btns');
  if(qbtns) qbtns.hidden = !glState.quizMode;

  /* ---- progress ---- */
  const total = glState.deck.length, cur = glState.index+1;
  const pt = glQ('gl-progress-text');
  if(pt) pt.textContent = `Card ${cur} of ${total}`;
  const pb = glQ('gl-progress-bar');
  if(pb) pb.style.width = `${(cur/total)*100}%`;
  const prevBtn = glQ('gl-prev'), nextBtn = glQ('gl-next');
  if(prevBtn) prevBtn.disabled = glState.index===0;
  if(nextBtn) nextBtn.disabled = glState.index===total-1;

  /* ---- score ---- */
  const sd = glQ('gl-score-display');
  if(sd){
    if(glState.quizMode){
      const s=glState.score;
      sd.textContent=`Score: ${s.correct} correct / ${s.wrong} wrong`;
      sd.hidden=false;
    } else { sd.hidden=true; }
  }

  /* ---- strip highlight ---- */
  document.querySelectorAll('.gl-thumb').forEach((el,i)=>
    el.classList.toggle('active', i===glState.index)
  );
  const activeThumb = document.querySelector(`.gl-thumb[data-gi="${glState.index}"]`);
  if(activeThumb) activeThumb.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'});
}

function glFlip(toBack){
  glState.flipped = toBack;
  const f=glQ('gl-front'), b=glQ('gl-back');
  if(f) f.hidden = toBack;
  if(b) b.hidden = !toBack;
  if(toBack && glState.autoplay) glSpeakAll();
}

function glNext(){
  if(glState.index < glState.deck.length-1){ glState.index++; glRenderCard(); }
  else { glShowComplete(); }
}
function glPrev(){
  if(glState.index>0){ glState.index--; glRenderCard(); }
}

function glSpeakName(){
  const g=glState.deck[glState.index]; if(!g) return;
  window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(`${g.label}. ${g.meaning}.`);
  u.lang='en-IN'; window.speechSynthesis.speak(u);
}
function glSpeakAll(){
  const g=glState.deck[glState.index]; if(!g) return;
  window.speechSynthesis.cancel();
  const txt=`${g.label}. Meaning: ${g.meaning}. In Hindi: ${g.hindi}. How to sign: ${g.steps.join('. ')}. ${g.tip?'Tip: '+g.tip:''}`;
  const u=new SpeechSynthesisUtterance(txt);
  u.lang='en-IN'; u.rate=0.9;
  if(glState.autoplay){
    u.onend=()=>{ glState.autoTimer=setTimeout(()=>{ if(glState.autoplay) glNext(); },1400); };
  }
  window.speechSynthesis.speak(u);
}
function glSpeakSteps(){
  const g=glState.deck[glState.index]; if(!g) return;
  window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(`How to sign ${g.label}: ${g.steps.join('. ')}.`);
  u.lang='en-IN'; u.rate=0.88; window.speechSynthesis.speak(u);
}

function glShuffle(){
  for(let i=glState.deck.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [glState.deck[i],glState.deck[j]]=[glState.deck[j],glState.deck[i]];
  }
  glState.index=0; glRenderCard(); glRenderStrip(); toast('Deck shuffled!');
}

function glToggleQuiz(on){
  glState.quizMode=on;
  glState.score={correct:0,wrong:0,total:0};
  glState.index=0;
  glRenderCard();
  const btn=glQ('gl-quiz-btn');
  if(btn) btn.textContent=on?'Exit Quiz':'Quiz Me';
  if(on) toast('Quiz mode on! Flip each card, then mark correct or wrong.');
}

function glShowComplete(){
  window.speechSynthesis.cancel();
  const s=glState.score;
  const msg=glState.quizMode
    ? `Deck complete! Score: ${s.correct} correct, ${s.wrong} wrong out of ${s.total}.`
    : `You studied all ${glState.deck.length} gestures in this set!`;
  toast(msg); speak(msg);
  if(glState.quizMode) glToggleQuiz(false);
}

function glRenderPills(){
  const container=glQ('gl-pills'); if(!container) return;
  const cats=['All',...new Set(ISL_REFERENCE.map(g=>g.category))];
  container.innerHTML=cats.map(cat=>{
    const count=cat==='All'?ISL_REFERENCE.length:ISL_REFERENCE.filter(g=>g.category===cat).length;
    return `<button class="isl-pill${cat===glState.activeCategory?' active':''}" data-glcat="${escapeHtml(cat)}">${escapeHtml(cat)} <span style="opacity:.7;font-size:9px">${count}</span></button>`;
  }).join('');
  container.querySelectorAll('[data-glcat]').forEach(btn=>btn.addEventListener('click',()=>{
    glBuildDeck(btn.dataset.glcat);
    container.querySelectorAll('[data-glcat]').forEach(b=>b.classList.toggle('active',b===btn));
    glRenderCard(); glRenderStrip();
  }));
}

function glRenderStrip(){
  const strip=glQ('gl-strip'); if(!strip) return;
  strip.innerHTML=glState.deck.map((g,i)=>{
    const col=glColor(g.category);
    const photoUrl=g.photos?.[0]?.url;
    const visual=photoUrl
      ? `<img class="gl-thumb-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(g.label)} gesture" loading="lazy">`
      : `<span class="${['Alphabet','Number'].includes(g.category)?'gl-thumb-label':''}">${escapeHtml(['Alphabet','Number'].includes(g.category)?g.label:g.symbol)}</span>`;
    return `<button class="gl-thumb${i===glState.index?' active':''}" data-gi="${i}" title="${g.label} — ${g.meaning}" style="border-color:${i===glState.index?col.accent:''}">
      ${visual}
      <span style="font-size:8px;color:#7c8499;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;width:100%;text-align:center">${g.label}</span>
    </button>`;
  }).join('');
  strip.querySelectorAll('[data-gi]').forEach(btn=>btn.addEventListener('click',()=>{
    glState.index=Number(btn.dataset.gi); glRenderCard();
  }));
}

function setupGestureLearn(){
  if(!glQ('gl-strip')) return;
  glBuildDeck('All');
  glRenderPills();
  glRenderCard();
  glRenderStrip();
  if(glState.ready) return;
  glState.ready=true;

  glQ('gl-prev').addEventListener('click', glPrev);
  glQ('gl-next').addEventListener('click', glNext);
  glQ('gl-flip').addEventListener('click', ()=>glFlip(true));
  glQ('gl-flip-back').addEventListener('click', ()=>glFlip(false));
  glQ('gl-speak-name').addEventListener('click', glSpeakName);
  glQ('gl-speak-all').addEventListener('click', glSpeakAll);
  glQ('gl-speak-steps').addEventListener('click', glSpeakSteps);
  glQ('gl-shuffle').addEventListener('click', glShuffle);
  glQ('gl-quiz-btn').addEventListener('click', ()=>glToggleQuiz(!glState.quizMode));
  glQ('gl-mark-correct').addEventListener('click', ()=>{ glState.score.correct++; glState.score.total++; glNext(); });
  glQ('gl-mark-wrong').addEventListener('click',   ()=>{ glState.score.wrong++;   glState.score.total++; glNext(); });
  glQ('gl-autoplay').addEventListener('change', e=>{
    glState.autoplay=e.target.checked; clearTimeout(glState.autoTimer);
    if(glState.autoplay) toast('Auto-advance on. Flip a card to begin.');
  });
  document.addEventListener('keydown', e=>{
    if(!document.getElementById('page-gesture-learn').classList.contains('active')) return;
    if(e.key==='ArrowRight'||e.key==='ArrowDown'){ e.preventDefault(); glNext(); }
    if(e.key==='ArrowLeft' ||e.key==='ArrowUp')  { e.preventDefault(); glPrev(); }
    if(e.key===' '||e.key==='Enter'){ e.preventDefault(); glFlip(!glState.flipped); }
    if(e.key==='s'||e.key==='S') glSpeakAll();
  });
}

// Dictionary ISL tab
let dictActiveTab = 'isl';
function setupDictTabs() {
  const tabs = document.querySelectorAll('[data-dtab]');
  if (!tabs.length) return;
  if (tabs[0].dataset.glInitDone) return;
  tabs[0].dataset.glInitDone = '1';
  tabs.forEach(btn => btn.addEventListener('click', () => {
    dictActiveTab = btn.dataset.dtab;
    tabs.forEach(b => b.classList.toggle('active', b === btn));
    renderDictContent();
  }));
  renderDictContent();
  const s = document.getElementById('dictionary-search');
  if (s) { s.oninput = null; s.addEventListener('input', renderDictContent); }
}
function renderDictContent() {
  const search = (document.getElementById('dictionary-search')?.value || '').toLowerCase();
  const grid = document.getElementById('dictionary-grid');
  const cnt  = document.getElementById('dictionary-count');
  if (!grid) return;
  const CAT_COLORS = {
    Alphabet:{ bg:'#e8ecff', accent:'#5368df' },
    Number:  { bg:'#e8f7ef', accent:'#26845b' },
    Greeting:{ bg:'#fff4df', accent:'#ae7d2c' },
    Common:  { bg:'#f4e8ff', accent:'#8e70d8' }
  };
  if (dictActiveTab === 'isl') {
    const vis = ISL_REFERENCE.filter(g =>
      (g.label+' '+g.meaning+' '+g.hindi+' '+g.category).toLowerCase().includes(search));
    if (cnt) cnt.textContent = vis.length + ' gestures';
    grid.innerHTML = vis.length ? vis.map(g => {
      const c = CAT_COLORS[g.category] || CAT_COLORS.Common;
      return '<article class="dict-isl-card" data-open-isl="'+g.id+'" tabindex="0" role="button">'
        +'<div class="dic-vis" style="background:'+c.bg+'">'
        +(g.photos?.length
          ? '<img class="dic-photo" src="'+escapeHtml(g.photos[0].url)+'" alt="'+escapeHtml(g.label)+' gesture" loading="lazy">'
          : '<span class="dic-emoji">'+escapeHtml(g.symbol || "✋")+'</span>')
        +'<span class="dic-kind" style="background:'+c.accent+'">'+g.kind+'</span></div>'
        +'<div class="dic-body"><span class="dic-cat" style="color:'+c.accent+'">'+g.category+'</span>'
        +'<h3 class="dic-label">'+g.label+'</h3>'
        +'<p class="dic-meaning">'+g.meaning+'</p>'
        +'<small class="dic-hindi">'+g.hindi+'</small></div>'
        +'<div class="dic-footer"><span>'+g.steps.length+' steps</span>'
        +'<span style="color:var(--primary);font-weight:600">View guide &#x2192;</span></div></article>';
    }).join('') : '<p class="empty-state">No matching gestures.</p>';
    grid.querySelectorAll('[data-open-isl]').forEach(card => {
      const open = () => openIslModal(card.dataset.openIsl);
      card.addEventListener('click', open);
      card.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') open(); });
    });
  } else {
    const gestures = state.gestureClasses || [];
    const vis = gestures.filter(g =>
      (g.label+' '+g.meaning+' '+g.category).toLowerCase().includes(search));
    if (cnt) cnt.textContent = vis.length + ' gestures';
    grid.innerHTML = vis.length ? vis.map(item =>
      '<article class="dictionary-item">'
      +'<span class="tag">'+item.category+' · '+item.kind+'</span>'
      +'<h2>'+item.label+'</h2><p>'+item.meaning+'</p>'
      +'<small>'+(item.ready?'Validated for local recognition':item.sample_count+' samples · collecting')+'</small>'
      +'</article>').join('') :
      '<p class="empty-state">No collected gestures yet. Add examples in AI Learning Mode.</p>';
  }
}
