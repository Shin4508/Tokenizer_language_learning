const languages = [
  { name: "English", code: "en-US", whisper: "en" },
  { name: "Japanese", code: "ja-JP", whisper: "ja" },
  { name: "Korean", code: "ko-KR", whisper: "ko" },
  { name: "Spanish", code: "es-ES", whisper: "es" },
  { name: "French", code: "fr-FR", whisper: "fr" },
  { name: "Mandarin Chinese", code: "zh-CN", whisper: "zh" },
  { name: "German", code: "de-DE", whisper: "de" },
  { name: "Italian", code: "it-IT", whisper: "it" },
];

const state = {
  history: [], busy: false, recorder: null, recordingStream: null, recordingChunks: [],
  cards: [], reviewQueue: [], reviewIndex: 0, momentDraft: null, audio: null,
  settings: {
    targetLanguage: localStorage.getItem("targetLanguage") || "Korean",
    nativeLanguage: localStorage.getItem("nativeLanguage") || "English",
    difficulty: localStorage.getItem("difficulty") || "Beginner",
    scenario: localStorage.getItem("scenario") || "Ordering at a neighborhood café",
  },
};

const ids = [
  "target-language", "native-language", "scenario", "setup-form", "messages", "welcome",
  "input", "send", "mic", "error", "recording-hint", "auto-speak", "status", "status-text",
  "session-language", "chat-title", "help-open", "help-dialog", "help-form", "help-submit",
  "help-error", "intended-meaning", "learner-attempt", "moment-tags", "moment-dialog",
  "moment-result", "moment-close", "moment-listen", "moment-save", "card-count", "due-count",
  "card-search", "tag-filter", "cards-grid", "review-progress", "review-stage", "toast",
];
const els = Object.fromEntries(ids.map(function (id) { return [id, document.getElementById(id)]; }));

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character];
  });
}

async function api(url, options) {
  const response = await fetch(url, options || {});
  const data = response.status === 204 ? null : await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error((data && data.error) || "Something went wrong.");
  return data;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(function () { els.toast.classList.remove("visible"); }, 2600);
}

function setError(message) {
  els.error.textContent = message || "";
  els.error.classList.toggle("visible", Boolean(message));
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.input.disabled = busy;
  els["help-open"].disabled = busy;
}

function settingsPayload() {
  return {
    targetLanguage: state.settings.targetLanguage, nativeLanguage: state.settings.nativeLanguage,
    difficulty: state.settings.difficulty, scenario: state.settings.scenario,
  };
}

function showView(name) {
  document.querySelectorAll(".view").forEach(function (view) {
    view.classList.toggle("active", view.id === name + "-view");
  });
  document.querySelectorAll(".nav-button").forEach(function (button) {
    button.classList.toggle("active", button.dataset.view === name);
  });
  if (name === "cards") loadCards();
  if (name === "review") loadReview();
  if (name === "chat") setTimeout(function () { els.input.focus(); }, 50);
}

function fillSetup() {
  languages.forEach(function (language) {
    ["target-language", "native-language"].forEach(function (id) {
      const option = document.createElement("option");
      option.value = language.name;
      option.textContent = language.name;
      els[id].append(option);
    });
  });
  els["target-language"].value = state.settings.targetLanguage;
  els["native-language"].value = state.settings.nativeLanguage;
  els.scenario.value = state.settings.scenario;
  const level = document.querySelector('input[name="difficulty"][value="' + state.settings.difficulty + '"]');
  if (level) level.checked = true;
  updateSessionHeading();
}

function updateSessionHeading() {
  els["session-language"].textContent = state.settings.targetLanguage.toUpperCase() + " · " + state.settings.difficulty.toUpperCase();
  els["chat-title"].textContent = state.settings.scenario;
  els.input.placeholder = "Write in " + state.settings.targetLanguage + "…";
}

function recentContext() {
  return state.history.slice(-4).map(function (message) {
    return (message.role === "user" ? "Learner: " : "Partner: ") + message.content;
  }).join("\n");
}

function addMessage(role, text, relatedUserText) {
  if (els.welcome) els.welcome.remove();
  const article = document.createElement("article");
  article.className = "message-row " + role;
  const avatar = role === "assistant" ? '<div class="avatar">L</div>' : "";
  const actions = role === "assistant"
    ? '<div class="message-actions"><button type="button" data-action="listen">▶ Listen</button><button type="button" data-action="save">＋ Save block</button></div>'
    : "";
  article.innerHTML = avatar + '<div class="bubble-wrap"><div class="bubble">' + escapeHtml(text) + "</div>" + actions + "</div>";
  if (role === "assistant") {
    article.querySelector('[data-action="listen"]').addEventListener("click", function () { speak(text, state.settings.targetLanguage); });
    article.querySelector('[data-action="save"]').addEventListener("click", function (event) {
      saveConversationBlock(event.currentTarget, relatedUserText || "", text);
    });
  }
  els.messages.append(article);
  els.messages.scrollTop = els.messages.scrollHeight;
  return article;
}

function addThinking() {
  const row = addMessage("assistant", "Thinking…");
  row.classList.add("thinking-row");
  row.querySelector(".message-actions").remove();
  return row;
}

async function sendMessage() {
  const message = els.input.value.trim();
  if (!message || state.busy) return;
  setError();
  els.input.value = "";
  resizeInput();
  stopAudio();
  addMessage("user", message);
  state.history.push({ role: "user", content: message });
  const thinking = addThinking();
  setBusy(true);
  try {
    const data = await api("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ messages: state.history }, settingsPayload())),
    });
    thinking.remove();
    state.history.push({ role: "assistant", content: data.message });
    addMessage("assistant", data.message, message);
    if (els["auto-speak"].checked) speak(data.message, state.settings.targetLanguage);
  } catch (error) {
    thinking.remove();
    state.history.pop();
    setError(error.message);
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

async function saveConversationBlock(button, userText, assistantText) {
  if (!userText) return;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const suggestion = await api("/api/help-me-say", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(settingsPayload(), {
        context: recentContext(), intendedMeaning: userText, learnerAttempt: userText,
      })),
    });
    await createCard(Object.assign(suggestion, {
      context: "You: " + userText + "\nPartner: " + assistantText,
      intendedMeaning: userText, learnerAttempt: userText, tags: [],
    }));
    button.textContent = "✓ Saved";
    showToast("Conversation block saved");
  } catch (error) {
    button.disabled = false;
    button.textContent = oldText;
    setError(error.message);
  }
}

function openHelp() {
  els["help-form"].reset();
  els["help-error"].textContent = "";
  els["help-dialog"].showModal();
  setTimeout(function () { els["intended-meaning"].focus(); }, 30);
}

async function requestPhrase(event) {
  event.preventDefault();
  const intendedMeaning = els["intended-meaning"].value.trim();
  if (!intendedMeaning) return;
  els["help-submit"].disabled = true;
  els["help-submit"].textContent = "Finding the natural phrase…";
  els["help-error"].textContent = "";
  try {
    const result = await api("/api/help-me-say", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(settingsPayload(), {
        context: recentContext(), intendedMeaning: intendedMeaning,
        learnerAttempt: els["learner-attempt"].value.trim(),
      })),
    });
    state.momentDraft = Object.assign(result, {
      context: recentContext(), intendedMeaning: intendedMeaning,
      learnerAttempt: els["learner-attempt"].value.trim(),
      tags: els["moment-tags"].value.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean),
    });
    renderMoment(state.momentDraft);
    els["help-dialog"].close();
    els["moment-dialog"].showModal();
  } catch (error) {
    els["help-error"].textContent = error.message;
  } finally {
    els["help-submit"].disabled = false;
    els["help-submit"].innerHTML = 'Show me how <span>→</span>';
  }
}

function renderMoment(moment) {
  els["moment-result"].innerHTML =
    '<div class="result-phrase"><span>Say this</span><strong>' + escapeHtml(moment.naturalExpression) + '</strong></div>' +
    '<div class="result-section"><span>They might reply</span><p>' + escapeHtml(moment.assistantReply) + '</p></div>' +
    '<div class="result-section"><span>Meaning</span><p>' + escapeHtml(moment.translation) + '</p></div>' +
    '<div class="result-section note"><span>Why it works</span><p>' + escapeHtml(moment.shortExplanation) + "</p></div>";
}

async function createCard(moment) {
  const data = await api("/api/cards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({}, moment, {
      language: state.settings.targetLanguage, difficulty: state.settings.difficulty,
      scenario: state.settings.scenario,
    })),
  });
  state.cards.unshift(data.card);
  updateCounts();
  return data.card;
}

async function saveMoment() {
  if (!state.momentDraft) return;
  els["moment-save"].disabled = true;
  try {
    await createCard(state.momentDraft);
    els["moment-dialog"].close();
    showToast("Learning moment saved");
  } catch (error) {
    showToast(error.message);
  } finally {
    els["moment-save"].disabled = false;
  }
}

async function loadCards() {
  const params = new URLSearchParams();
  if (els["card-search"].value.trim()) params.set("q", els["card-search"].value.trim());
  if (els["tag-filter"].value.trim()) params.set("tag", els["tag-filter"].value.trim());
  try {
    state.cards = (await api("/api/cards?" + params.toString())).cards;
    renderCards();
  } catch (error) {
    els["cards-grid"].innerHTML = '<div class="empty-state"><h2>Cards could not load</h2><p>' + escapeHtml(error.message) + "</p></div>";
  }
}

function renderCards() {
  if (!state.cards.length) {
    els["cards-grid"].innerHTML = '<div class="empty-state"><span>✦</span><h2>No moments here yet</h2><p>Use “How do I say…” during a conversation to save your first useful phrase.</p><button class="primary" type="button" data-empty-practice>Start practicing</button></div>';
    els["cards-grid"].querySelector("[data-empty-practice]").addEventListener("click", function () { showView("chat"); });
    return;
  }
  els["cards-grid"].innerHTML = state.cards.map(function (card) {
    const tags = card.tags.map(function (tag) {
      return '<button type="button" data-tag="' + escapeHtml(tag) + '">#' + escapeHtml(tag) + "</button>";
    }).join("");
    return '<article class="learning-card" data-card-id="' + card.id + '">' +
      '<div class="card-top"><span>' + escapeHtml(card.language) + " · " + escapeHtml(card.difficulty) +
      '</span><span class="' + (card.is_due ? "due" : "") + '">' + (card.is_due ? "Due now" : formatDue(card.due_at)) + "</span></div>" +
      '<p class="card-prompt">' + escapeHtml(card.intended_meaning) + "</p><h2>" + escapeHtml(card.natural_expression) + "</h2>" +
      '<p class="translation">' + escapeHtml(card.translation) + '</p><div class="tag-list">' + tags + "</div>" +
      '<div class="card-actions"><button type="button" data-card-listen>▶ Listen</button><button type="button" data-card-tags>＋ Tags</button>' +
      '<button type="button" data-card-delete>Delete</button></div></article>';
  }).join("");
  els["cards-grid"].querySelectorAll(".learning-card").forEach(function (node) {
    const card = state.cards.find(function (item) { return item.id === Number(node.dataset.cardId); });
    node.querySelector("[data-card-listen]").addEventListener("click", function () { speakBlock(card); });
    node.querySelector("[data-card-tags]").addEventListener("click", function () { editTags(card); });
    node.querySelector("[data-card-delete]").addEventListener("click", function () { deleteCard(card); });
    node.querySelectorAll("[data-tag]").forEach(function (button) {
      button.addEventListener("click", function () { els["tag-filter"].value = button.dataset.tag; loadCards(); });
    });
  });
}

async function editTags(card) {
  const value = window.prompt("Tags, separated by commas", card.tags.join(", "));
  if (value === null) return;
  try {
    Object.assign(card, (await api("/api/cards/" + card.id, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: value.split(",") }),
    })).card);
    renderCards();
  } catch (error) { showToast(error.message); }
}

async function deleteCard(card) {
  if (!window.confirm('Delete “‘' + card.natural_expression + '”? This cannot be undone.')) return;
  try {
    await api("/api/cards/" + card.id, { method: "DELETE" });
    state.cards = state.cards.filter(function (item) { return item.id !== card.id; });
    renderCards();
    updateCounts();
    showToast("Card deleted");
  } catch (error) { showToast(error.message); }
}

function formatDue(value) {
  const days = Math.ceil((new Date(value) - Date.now()) / 86400000);
  if (days <= 0) return "Due now";
  return days === 1 ? "Tomorrow" : "In " + days + " days";
}

async function updateCounts() {
  try {
    const results = await Promise.all([api("/api/cards"), api("/api/cards?due=1")]);
    els["card-count"].textContent = results[0].cards.length;
    els["due-count"].textContent = results[1].cards.length;
  } catch (_) {}
}

async function loadReview() {
  try {
    state.reviewQueue = (await api("/api/cards?due=1")).cards;
    state.reviewIndex = 0;
    renderReview();
    updateCounts();
  } catch (error) {
    els["review-stage"].innerHTML = '<div class="empty-state"><h2>Review could not load</h2><p>' + escapeHtml(error.message) + "</p></div>";
  }
}

function renderReview() {
  const total = state.reviewQueue.length;
  const card = state.reviewQueue[state.reviewIndex];
  if (!card) {
    els["review-progress"].textContent = total ? total + " moments reviewed" : "Your memory garden is up to date.";
    els["review-stage"].innerHTML = '<div class="empty-state review-complete"><span>✓</span><h2>All caught up</h2><p>New and difficult moments will return when they are ready.</p><button class="primary" type="button" data-practice>Keep practicing</button></div>';
    els["review-stage"].querySelector("[data-practice]").addEventListener("click", function () { showView("chat"); });
    return;
  }
  els["review-progress"].textContent = "Card " + (state.reviewIndex + 1) + " of " + total;
  els["review-stage"].innerHTML = '<div class="review-card" id="active-review-card">' +
    '<div class="review-context"><span>In this moment</span><p>' + escapeHtml(card.context || card.scenario) + "</p></div>" +
    '<div class="review-question"><span>You wanted to say</span><h2>' + escapeHtml(card.intended_meaning) + "</h2><p>What would you say here?</p></div>" +
    '<button class="primary reveal-button" type="button" data-reveal>Reveal answer</button>' +
    '<div class="review-answer"><span>Natural expression</span><h2>' + escapeHtml(card.natural_expression) + '</h2><p class="translation">' +
    escapeHtml(card.translation) + '</p><div class="explanation">' + escapeHtml(card.short_explanation) +
    '</div><button class="listen-line" type="button" data-review-listen>▶ Read the whole block aloud</button>' +
    '<div class="rating-row"><button type="button" data-rating="forgot"><strong>Forgot</strong><small>Again in 10 min</small></button>' +
    '<button type="button" data-rating="hard"><strong>Hard</strong><small>Short interval</small></button>' +
    '<button type="button" data-rating="correct"><strong>Got it</strong><small>Longer interval</small></button></div></div></div>';
  const reviewCard = document.getElementById("active-review-card");
  reviewCard.querySelector("[data-reveal]").addEventListener("click", function (event) {
    reviewCard.classList.add("revealed");
    event.currentTarget.remove();
    speak(card.natural_expression, card.language);
  });
  reviewCard.querySelector("[data-review-listen]").addEventListener("click", function () { speakBlock(card); });
  reviewCard.querySelectorAll("[data-rating]").forEach(function (button) {
    button.addEventListener("click", function () { rateCard(card, button.dataset.rating); });
  });
}

async function rateCard(card, rating) {
  els["review-stage"].querySelectorAll("button").forEach(function (button) { button.disabled = true; });
  try {
    await api("/api/cards/" + card.id + "/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating: rating }),
    });
    state.reviewIndex += 1;
    renderReview();
    updateCounts();
  } catch (error) { showToast(error.message); renderReview(); }
}

function stopAudio() {
  if (state.audio) {
    state.audio.pause();
    URL.revokeObjectURL(state.audio.src);
    state.audio = null;
  }
}

async function speak(text, language) {
  stopAudio();
  clearTimeout(showToast.timer);
  els.toast.textContent = "Generating local voice…";
  els.toast.classList.add("visible");
  try {
    const response = await fetch("/api/speak", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, language: language || state.settings.targetLanguage }),
    });
    if (!response.ok) {
      const data = await response.json().catch(function () { return {}; });
      throw new Error(data.error || "Qwen3-TTS could not create the audio.");
    }
    const url = URL.createObjectURL(await response.blob());
    state.audio = new Audio(url);
    state.audio.onended = stopAudio;
    state.audio.onerror = function () { stopAudio(); showToast("The audio could not be played."); };
    await state.audio.play();
    showToast("Playing local voice");
  } catch (error) { showToast(error.message); }
}

function speakBlock(card) {
  speak(card.natural_expression + ". " + card.assistant_reply, card.language || state.settings.targetLanguage);
}

async function toggleRecording() {
  if (state.recorder) { state.recorder.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return setError("Voice input is unavailable in this browser.");
  }
  try {
    state.recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(function (type) {
      return MediaRecorder.isTypeSupported(type);
    });
    state.recordingChunks = [];
    state.recorder = new MediaRecorder(state.recordingStream, mimeType ? { mimeType: mimeType } : undefined);
    state.recorder.ondataavailable = function (event) { if (event.data.size) state.recordingChunks.push(event.data); };
    state.recorder.onstop = transcribeRecording;
    state.recorder.start();
    els.mic.classList.add("recording");
    els.mic.textContent = "■";
    els["recording-hint"].textContent = "Listening… tap stop when you finish";
  } catch (_) { setError("Microphone access was denied."); }
}

async function transcribeRecording() {
  const mimeType = state.recorder.mimeType;
  state.recorder = null;
  if (state.recordingStream) state.recordingStream.getTracks().forEach(function (track) { track.stop(); });
  state.recordingStream = null;
  els.mic.classList.remove("recording");
  els.mic.textContent = "●";
  els["recording-hint"].textContent = "Transcribing with Whisper…";
  try {
    const form = new FormData();
    form.append("audio", new Blob(state.recordingChunks, { type: mimeType }), mimeType.includes("mp4") ? "recording.m4a" : "recording.webm");
    const language = languages.find(function (item) { return item.name === state.settings.targetLanguage; }) || languages[0];
    form.append("language", language.whisper);
    els.input.value = (await api("/api/transcribe", { method: "POST", body: form })).text;
    resizeInput();
    els.input.focus();
  } catch (error) { setError(error.message); }
  els["recording-hint"].textContent = "Tap the microphone for voice input";
}

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 128) + "px";
}

async function checkHealth() {
  try {
    const data = await api("/api/health");
    els.status.classList.toggle("online", data.ollama);
    els["status-text"].textContent = data.ollama
      ? "Qwen chat ready · local voice " + (data.tts_loaded ? "loaded" : "loads on first use")
      : "Ollama is offline";
  } catch (_) { els["status-text"].textContent = "Server is offline"; }
}

document.querySelectorAll("[data-view]").forEach(function (button) {
  button.addEventListener("click", function () { showView(button.dataset.view); });
});
els["setup-form"].addEventListener("submit", function (event) {
  event.preventDefault();
  state.settings = {
    targetLanguage: els["target-language"].value, nativeLanguage: els["native-language"].value,
    difficulty: document.querySelector('input[name="difficulty"]:checked').value,
    scenario: els.scenario.value.trim() || "Everyday conversation",
  };
  Object.entries(state.settings).forEach(function (entry) { localStorage.setItem(entry[0], entry[1]); });
  state.history = [];
  els.messages.innerHTML = '<div class="welcome" id="welcome"><span class="welcome-mark">✦</span><h2>Ready when you are.</h2><p>Say hello in your target language, or ask Lingua for the phrase you need.</p></div>';
  els.welcome = document.getElementById("welcome");
  updateSessionHeading();
  showView("chat");
});
els.send.addEventListener("click", sendMessage);
els.input.addEventListener("input", resizeInput);
els.input.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
els.mic.addEventListener("click", toggleRecording);
els["help-open"].addEventListener("click", openHelp);
els["help-form"].addEventListener("submit", requestPhrase);
els["moment-close"].addEventListener("click", function () { els["moment-dialog"].close(); });
els["moment-listen"].addEventListener("click", function () { speakBlock(state.momentDraft); });
els["moment-save"].addEventListener("click", saveMoment);
let searchTimer;
[els["card-search"], els["tag-filter"]].forEach(function (input) {
  input.addEventListener("input", function () { clearTimeout(searchTimer); searchTimer = setTimeout(loadCards, 220); });
});

fillSetup();
checkHealth();
updateCounts();
