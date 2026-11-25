const STORAGE_KEY = "murmur-chat-state-v1";
const ASSET_DB_NAME = "murmur-chat-assets";
const ASSET_STORE_NAME = "files";
const DEFAULT_BOOKS = [
  { id: "realistic-chat", name: "真实人类聊天习惯", url: "./worldbooks/realistic-chat.txt?v=10" },
  { id: "memes", name: "热梗", url: "./worldbooks/memes.txt?v=10" }
];
const defaultBookContents = new Map();
const defaultBooksReady = Promise.all(DEFAULT_BOOKS.map(async (book) => {
  const response = await fetch(book.url);
  if (!response.ok) throw new Error(`无法载入${book.name}`);
  defaultBookContents.set(book.id, await response.text());
}));

const defaults = {
  user: { name: "陆鹭", persona: "", avatar: "" },
  settings: {
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: "",
    model: "deepseek-flash",
    temperature: 0.9,
    accent: "#f4a4c0",
    background: "#ebebeb",
    panel: "#ebebeb",
    incomingBubbleColor: "#ffffff",
    actionBubbleColor: "#dcdcdc",
    textColor: "#000000",
    mutedColor: "#000000",
    outgoingTextColor: "#ffffff",
    bubbleRadius: 18,
    font: "system",
    customFontName: "",
    chatBackground: "",
    homeWallpaper: "",
    appIcons: {}
  },
  characters: [
    {
      id: "welcome-character",
      name: "新朋友",
      subtitle: "等待你写下人物设定",
      persona: "你是一位温和、自然的朋友。回复简洁但有温度，会认真回应对方说的话。",
      greeting: "在的。你想从哪里开始聊？",
      avatar: "",
      showActionBubbles: true,
      messages: []
    }
  ],
  worldBooks: [],
  enabledDefaultBooks: [],
  brand: { title: "Wechat", subtitle: "要和谁喵喵天？" },
  relationships: [],
  groups: [],
  activeGroupId: null,
  activeId: "welcome-character",
  homeAppOrder: ["wechat", "settings", "appearance", "worldbooks"]
};

let state = loadState();
let pendingAvatar = "";
let pendingUserAvatar = "";
let pendingGroupAvatar = "";
let selection = null;
let pendingBackground = "";
let pendingHomeWallpaper = "";
let pendingAppIcons = {};
let pendingCustomFontName = "";
let isReplying = false;
let replyingCharacterId = null;
let activeCustomFontFace = null;
let selectedMessage = null;
let pressTimer = null;
let editMessageIndex = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  app: $(".app-shell"),
  characterList: $("#characterList"),
  messages: $("#messages"),
  activeAvatar: $("#activeAvatar"),
  activeName: $("#activeName"),
  activeStatus: $("#activeStatus"),
  userAvatar: $("#userAvatar"),
  input: $("#messageInput"),
  composer: $("#composer"),
  send: $("#sendMessage"),
  reply: $("#requestReply"),
  characterModal: $("#characterModal"),
  settingsModal: $("#settingsModal"),
  characterForm: $("#characterForm"),
  settingsForm: $("#settingsForm"),
  toast: $("#toast")
};

function showScreen(screen) {
  $("#homeScreen").hidden = screen !== "home";
  els.app.hidden = screen !== "wechat";
  $("#phoneStage").dataset.screen = screen;
  if (screen === "home") { selection = null; els.app.classList.remove("show-chat"); }
}
function refreshPhoneClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  $("#phoneClock").textContent = time;
  $("#homeDate").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(now);
}
refreshPhoneClock();
setInterval(refreshPhoneClock, 30000);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return clone(defaults);
    return {
      ...clone(defaults),
      ...saved,
      user: { ...defaults.user, ...(saved.user || {}) },
      settings: { ...defaults.settings, ...(saved.settings || {}) },
      characters: Array.isArray(saved.characters) ? saved.characters : clone(defaults.characters),
      worldBooks: Array.isArray(saved.worldBooks) ? saved.worldBooks : [],
      enabledDefaultBooks: Array.isArray(saved.enabledDefaultBooks) ? saved.enabledDefaultBooks : [],
      brand: { ...defaults.brand, ...(saved.brand || {}) },
      relationships: Array.isArray(saved.relationships) ? saved.relationships : [],
      groups: Array.isArray(saved.groups) ? saved.groups : [],
      homeAppOrder: Array.isArray(saved.homeAppOrder) ? saved.homeAppOrder : [...defaults.homeAppOrder]
    };
  } catch {
    return clone(defaults);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function openAssetDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
        request.result.createObjectStore(ASSET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readAsset(key) {
  const database = await openAssetDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE_NAME, "readonly");
    const request = transaction.objectStore(ASSET_STORE_NAME).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
    transaction.oncomplete = () => database.close();
  });
}

async function writeAsset(key, value) {
  const database = await openAssetDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
    transaction.objectStore(ASSET_STORE_NAME).put(value, key);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
  });
}

async function removeAsset(key) {
  const database = await openAssetDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
    transaction.objectStore(ASSET_STORE_NAME).delete(key);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
  });
}

async function installCustomFont(fontFile) {
  if (activeCustomFontFace) document.fonts.delete(activeCustomFontFace);
  const fontUrl = URL.createObjectURL(fontFile);
  try {
    const fontFace = new FontFace("MurmurCustom", `url(${fontUrl})`);
    await fontFace.load();
    document.fonts.add(fontFace);
    activeCustomFontFace = fontFace;
  } finally {
    URL.revokeObjectURL(fontUrl);
  }
}

async function restoreCustomFont() {
  const fontFile = await readAsset("customFont");
  if (fontFile) await installCustomFont(fontFile);
}

function activeGroup() {
  return state.groups.find((group) => group.id === state.activeGroupId) || null;
}

function activeChat() { return activeGroup() || activeCharacter(); }

function chatKey(chat) { return chat ? `${activeGroup() === chat ? "group" : "character"}:${chat.id}` : null; }

function activeCharacter() {
  return state.characters.find((character) => character.id === state.activeId) || state.characters[0] || null;
}

function initials(name) {
  return (name || "角").trim().slice(0, 1).toUpperCase();
}

function setAvatar(element, name, image) {
  element.textContent = image ? "" : initials(name);
  element.style.backgroundImage = image ? `url(${JSON.stringify(image).slice(1, -1)})` : "";
}

function lastBubble(message, showActions = true) {
  if (!message) return "";
  if (message.role === "system_notice") return noticeText(message);
  if (message.role === "user") return message.content || "";
  const segments = (message.segments || []).filter((segment) => showActions || segment.type !== "action");
  return segments.at(-1)?.text || message.content || "";
}
function noticeText(message) { return (message.content || "").replaceAll("[user]", state.user.name || "我"); }
function groupAvatarTiles(group) {
  return (group.memberIds || []).map((id) => {
    const person = state.characters.find((item) => item.id === id);
    return `<span class="group-avatar-tile" ${person?.avatar ? `style="background-image:url('${escapeHtml(person.avatar)}')"` : ""}>${person?.avatar ? "" : escapeHtml(initials(person?.name || "角"))}</span>`;
  }).join("");
}
function groupAvatarMarkup(group, extraClass = "") {
  if (group.avatar) return `<span class="avatar group-avatar ${extraClass}" style="background-image:url('${escapeHtml(group.avatar)}')"></span>`;
  return `<span class="avatar group-avatar is-collage ${extraClass}" style="--tile-cols:${Math.ceil(Math.sqrt(group.memberIds?.length || 1))}">${groupAvatarTiles(group) || "群"}</span>`;
}
function paintGroupAvatar(element, group) {
  element.classList.add("group-avatar");
  element.classList.toggle("is-collage", !group.avatar);
  element.style.backgroundImage = group.avatar ? `url(${JSON.stringify(group.avatar).slice(1, -1)})` : "";
  element.style.setProperty("--tile-cols", Math.ceil(Math.sqrt(group.memberIds?.length || 1)));
  element.innerHTML = group.avatar ? "" : groupAvatarTiles(group) || "群";
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const HOME_APPS = [
  { id: "wechat", name: "Wechat" }, { id: "settings", name: "设置" },
  { id: "appearance", name: "外观" }, { id: "worldbooks", name: "世界书" }
];
function normalizedHomeOrder() {
  return [...new Set([...(state.homeAppOrder || []), ...HOME_APPS.map((app) => app.id)])]
    .filter((id) => HOME_APPS.some((app) => app.id === id));
}
function renderHomeApps() {
  const grid = $(".home-apps");
  const buttons = new Map([...grid.querySelectorAll("[data-app-id]")].map((button) => [button.dataset.appId, button]));
  for (const id of normalizedHomeOrder()) grid.append(buttons.get(id));
  for (const [id, button] of buttons) {
    const icon = button.querySelector(".app-icon");
    const image = state.settings.appIcons?.[id];
    icon.classList.toggle("has-custom-icon", Boolean(image));
    icon.style.backgroundImage = image ? `url(${JSON.stringify(image).slice(1, -1)})` : "";
  }
}
function renderAppIconSettings() {
  $("#appIconSettings").innerHTML = HOME_APPS.map(({ id, name }) => {
    const image = pendingAppIcons[id];
    return `<div class="icon-setting-row"><span class="icon-preview" ${image ? `style="background-image:url('${escapeHtml(image)}')"` : ""}>${image ? "" : escapeHtml(name.slice(0, 1))}</span><strong>${escapeHtml(name)}</strong><label class="secondary-button file-label">替换图片<input type="file" data-app-icon="${id}" accept="image/*" hidden /></label><button class="link-button" type="button" data-reset-app-icon="${id}">恢复默认</button></div>`;
  }).join("");
}

function render() {
  if (selection && selection.chat !== activeChat()) selection = null;
  applyTheme();
  renderUser();
  $("#brandTitle").textContent = state.brand.title;
  $("#brandSubtitle").textContent = state.brand.subtitle;
  renderCharacters($("#searchCharacters").value || "");
  renderHomeApps();
  renderActiveChat();
  renderSelectionToolbar();
}

function renderUser() {
  setAvatar(els.userAvatar, state.user.name || "我", state.user.avatar);
}

function renderCharacters(query = "") {
  const normalized = query.trim().toLowerCase();
  const groups = state.groups.filter((group) => `${group.name} ${group.memberIds.map(personName).join(" ")}`.toLowerCase().includes(normalized));
  const characters = state.characters.filter((character) => `${character.name} ${character.subtitle}`.toLowerCase().includes(normalized));
  const groupHtml = groups.map((group) => {
    const last = group.messages?.at(-1);
    const preview = last ? lastBubble(last) : group.memberIds.map(personName).join("、");
    return `<button class="character-item ${state.activeGroupId === group.id ? "is-active" : ""}" data-group-id="${escapeHtml(group.id)}">
      ${groupAvatarMarkup(group)}<span class="character-info"><strong>${escapeHtml(group.name)}</strong><span>${escapeHtml(preview)}</span></span>
      <span class="character-time">${last ? formatTime(last.createdAt) : ""}</span></button>`;
  }).join("");
  const personHtml = characters.map((character) => {
    const lastMessage = character.messages?.at(-1);
    const preview = lastMessage ? lastBubble(lastMessage, character.showActionBubbles !== false)
      : character.greeting || character.signature || "开始对话";
    const avatarStyle = character.avatar ? `style="background-image:url('${escapeHtml(character.avatar)}')"` : "";
    return `<button class="character-item ${!state.activeGroupId && character.id === state.activeId ? "is-active" : ""}" data-character-id="${escapeHtml(character.id)}">
      <span class="avatar" ${avatarStyle}>${character.avatar ? "" : escapeHtml(initials(character.name))}</span>
      <span class="character-info"><strong>${escapeHtml(character.name)}</strong><span>${escapeHtml(preview)}</span></span>
      <span class="character-time">${lastMessage ? formatTime(lastMessage.createdAt) : ""}</span></button>`;
  }).join("");
  els.characterList.innerHTML = groupHtml + personHtml || `<div class="empty-state"><div><strong>没有找到聊天</strong><span>试试换个关键词。</span></div></div>`;
  $$(".character-item").forEach((button) => button.addEventListener("click", () => {
    state.activeGroupId = button.dataset.groupId || null;
    if (button.dataset.characterId) state.activeId = button.dataset.characterId;
    saveState(); render(); els.app.classList.add("show-chat");
  }));
}

function displayMessages(character) {
  const messages = [...(character.messages || [])];
  if (!messages.length && character.greeting) {
    messages.push({ role: "assistant", content: character.greeting, createdAt: Date.now(), greeting: true });
  }
  return messages;
}

function pendingMessageCount(character) {
  let count = 0;
  for (let index = (character.messages || []).length - 1; index >= 0; index--) {
    if (!["user", "system_notice"].includes(character.messages[index].role)) break;
    count++;
  }
  return count;
}

function renderActiveChat() {
  const group = activeGroup();
  const chat = group || activeCharacter();
  if (!chat) {
    els.activeName.textContent = "还没有人物";
    els.activeStatus.textContent = "点击左上角添加人物";
    setAvatar(els.activeAvatar, "角", "");
    els.messages.innerHTML = `<div class="empty-state"><div><strong>创建你的第一个人物</strong><span>填写姓名、头像和设定后，就可以开始聊天。</span></div></div>`;
    els.input.disabled = true; els.send.disabled = true; els.reply.disabled = true;
    return;
  }
  els.input.disabled = false;
  els.send.disabled = isReplying;
  const pendingCount = pendingMessageCount(chat);
  els.reply.disabled = isReplying;
  els.reply.innerHTML = pendingCount ? `🫧<span class="reply-count">${pendingCount}</span>` : "🫧";
  els.reply.setAttribute("aria-label", pendingCount ? `让朋友回复，待回复消息 ${pendingCount} 条` : "让朋友主动发消息");
  els.reply.title = pendingCount ? "让朋友回复" : "让朋友主动发消息";
  els.activeName.textContent = chat.name;
  els.activeStatus.textContent = isReplying && replyingCharacterId === chatKey(chat) ? "正在输入…" :
    (group ? group.memberIds.map(personName).join("、") : chat.signature || "在线");
  if (group) paintGroupAvatar(els.activeAvatar, group);
  else { els.activeAvatar.classList.remove("group-avatar", "is-collage"); setAvatar(els.activeAvatar, chat.name, chat.avatar); }
  $("#editCharacter").setAttribute("aria-label", group ? "编辑群聊" : "编辑人物");
  $("#editCharacter").title = group ? "编辑群聊" : "编辑人物";
  const messages = group ? (group.messages || []) : displayMessages(chat);
  if (!messages.length) {
    els.messages.innerHTML = `<div class="empty-state"><div><strong>${group ? "群聊已建立" : `和 ${escapeHtml(chat.name)} 打个招呼`}</strong><span>${group ? "发消息，或点 🫧 让角色先聊起来。" : "这里的内容只保存在当前设备。"}</span></div></div>`;
  } else {
    els.messages.innerHTML = messages.map((message, index) => {
      if (message.role === "system_notice") return `<div class="message-row is-notice"><span class="notice-bubble">${escapeHtml(noticeText(message))}</span></div>`;
      const speaker = group && message.role !== "user" ? state.characters.find((item) => item.id === message.speakerId) : chat;
      const allSegments = message.role === "user" ? [{ type: "speech", text: message.content }] :
        (Array.isArray(message.segments) && message.segments.length ? message.segments : [{ type: "speech", text: message.content }]);
      const segments = allSegments.map((segment, originalIndex) => ({ ...segment, originalIndex }))
        .filter((segment) => speaker?.showActionBubbles !== false || segment.type !== "action");
      return segments.map((segment, segmentIndex) => {
        const isAction = segment.type === "action";
        const groupSpeaker = group && message.role !== "user" && !isAction;
        const speakerLabel = groupSpeaker ? `<span class="speaker-label">${escapeHtml(speaker?.name || "已删除角色")}</span>` : "";
        const speakerAvatar = groupSpeaker ? `<span class="avatar message-avatar mention-avatar" data-speaker-id="${escapeHtml(speaker?.id || "")}" role="button" tabindex="0" aria-label="长按 @${escapeHtml(speaker?.name || "角色")}" ${speaker?.avatar ? `style="background-image:url('${escapeHtml(speaker.avatar)}')"` : ""}>${speaker?.avatar ? "" : escapeHtml(initials(speaker?.name || "角"))}</span>` : "";
        const selected = selection?.chat === chat && selection.keys.has(`${index}:${segment.originalIndex}`);
        return `<div class="message-row ${message.role === "user" ? "is-user" : ""} ${isAction ? "is-action" : ""} ${selected ? "is-selected" : ""}">
          ${speakerAvatar}<div class="message-content">${speakerLabel}
            <div class="message-bubble" data-message-index="${message.greeting ? -1 : index}" data-segment-index="${segment.originalIndex}" tabindex="0" aria-label="${message.role === "user" ? "我的消息" : "朋友的消息"}，长按可操作">${escapeHtml(segment.text)}</div>
            ${segmentIndex === segments.length - 1 ? `<div class="message-meta">${formatTime(message.createdAt)}</div>` : ""}
          </div></div>`;
      }).join("");
    }).join("");
  }
  if (isReplying && replyingCharacterId === chatKey(chat)) {
    els.messages.insertAdjacentHTML("beforeend", `<div class="message-row"><div class="message-bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
  }
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

function applyTheme() {
  const root = document.documentElement;
  const settings = state.settings;
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--bg", settings.background);
  root.style.setProperty("--panel", settings.panel);
  root.style.setProperty("--incoming-bubble", settings.incomingBubbleColor);
  root.style.setProperty("--action-bubble", settings.actionBubbleColor);
  const hex = settings.background.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const dark = rgb.reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0) < 128;
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--line", dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.1)");
  root.style.setProperty("--text", settings.textColor);
  root.style.setProperty("--muted", settings.mutedColor);
  root.style.setProperty("--outgoing-text", settings.outgoingTextColor);
  root.style.setProperty("--bubble-radius", `${settings.bubbleRadius}px`);
  const fonts = {
    system: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    serif: '"Songti SC", "Noto Serif CJK SC", Georgia, serif',
    rounded: '"Arial Rounded MT Bold", "PingFang SC", ui-sans-serif, sans-serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    custom: '"MurmurCustom", Inter, ui-sans-serif, sans-serif'
  };
  root.style.setProperty("--font", fonts[settings.font] || fonts.system);
  root.style.setProperty("--chat-background", settings.chatBackground ? `url(${JSON.stringify(settings.chatBackground).slice(1, -1)})` : "none");
  root.style.setProperty("--home-wallpaper", settings.homeWallpaper ? `url(${JSON.stringify(settings.homeWallpaper).slice(1, -1)})` : "none");
  $("meta[name='theme-color']").setAttribute("content", settings.background);
}

function openModal(modal) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  modal.hidden = false;
}

function closeModals() {
  $$(".modal-backdrop").forEach((modal) => { modal.hidden = true; });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), 2200);
}

function fileToDataUrl(file, maxDimension = 900, quality = 0.86) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let cropState = null;
const cropCanvas = $("#cropCanvas");
const cropContext = cropCanvas.getContext("2d");
function cropMetrics() {
  const { image, zoom } = cropState;
  const scale = Math.max(320 / image.naturalWidth, 320 / image.naturalHeight) * zoom;
  return { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
}
function clampCrop() {
  const { width, height } = cropMetrics();
  cropState.x = Math.max(320 - width, Math.min(0, cropState.x));
  cropState.y = Math.max(320 - height, Math.min(0, cropState.y));
}
function drawCrop() {
  if (!cropState) return;
  clampCrop();
  const { width, height } = cropMetrics();
  cropContext.clearRect(0, 0, 320, 320);
  cropContext.drawImage(cropState.image, cropState.x, cropState.y, width, height);
}
async function openCropEditor(file, target) {
  if (!file.type.startsWith("image/")) { showToast("请选择图片文件"); return; }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片无法读取");
    cropState = { image, url, target, zoom: 1, x: 0, y: 0, pointer: null };
    const { width, height } = cropMetrics();
    cropState.x = (320 - width) / 2;
    cropState.y = (320 - height) / 2;
    $("#cropZoom").value = "1";
    drawCrop();
    openModal($("#cropModal"));
  } catch (error) {
    URL.revokeObjectURL(url);
    showToast(error.message || "图片无法读取");
  }
}
function closeCropEditor() {
  $("#cropModal").hidden = true;
  if (cropState) URL.revokeObjectURL(cropState.url);
  cropState = null;
}
$("#closeCrop").addEventListener("click", closeCropEditor);
$("#cancelCrop").addEventListener("click", closeCropEditor);
$("#cropModal").addEventListener("click", (event) => { if (event.target.id === "cropModal") closeCropEditor(); });
cropCanvas.addEventListener("pointerdown", (event) => {
  if (!cropState) return;
  cropState.pointer = { x: event.clientX, y: event.clientY };
  cropCanvas.setPointerCapture(event.pointerId);
});
cropCanvas.addEventListener("pointermove", (event) => {
  if (!cropState?.pointer) return;
  const scale = 320 / cropCanvas.getBoundingClientRect().width;
  cropState.x += (event.clientX - cropState.pointer.x) * scale;
  cropState.y += (event.clientY - cropState.pointer.y) * scale;
  cropState.pointer = { x: event.clientX, y: event.clientY };
  drawCrop();
});
["pointerup", "pointercancel"].forEach((name) => cropCanvas.addEventListener(name, () => { if (cropState) cropState.pointer = null; }));
$("#cropZoom").addEventListener("input", (event) => {
  if (!cropState) return;
  const oldZoom = cropState.zoom;
  const ratio = Number(event.target.value) / oldZoom;
  cropState.x = 160 - (160 - cropState.x) * ratio;
  cropState.y = 160 - (160 - cropState.y) * ratio;
  cropState.zoom = Number(event.target.value);
  drawCrop();
});
$("#applyCrop").addEventListener("click", () => {
  if (!cropState) return;
  const output = document.createElement("canvas");
  output.width = 700; output.height = 700;
  const { width, height } = cropMetrics();
  output.getContext("2d").drawImage(cropState.image,
    cropState.x * 700 / 320, cropState.y * 700 / 320,
    width * 700 / 320, height * 700 / 320);
  const avatar = output.toDataURL("image/jpeg", 0.85);
  if (cropState.target === "character") {
    pendingAvatar = avatar;
    setAvatar($("#characterAvatarPreview"), $("#characterName").value || "角", avatar);
  } else if (cropState.target === "group") {
    pendingGroupAvatar = avatar;
    updateGroupAvatarPreview();
  } else {
    pendingUserAvatar = avatar;
    setAvatar($("#userAvatarPreview"), $("#userName").value || "我", avatar);
  }
  closeCropEditor();
});

function renderCorrections(character) {
  const list = $("#characterCorrections");
  list.innerHTML = character?.oocCorrections?.length
    ? character.oocCorrections.map((item) => `<div class="correction-item" data-correction-id="${escapeHtml(item.id)}">
        <textarea rows="2" aria-label="纠偏内容">${escapeHtml(item.text)}</textarea>
        <div><button class="secondary-button" type="button" data-correction-action="save">保存修改</button>
        <button class="danger-button" type="button" data-correction-action="delete">删除</button></div></div>`).join("")
    : '<p class="field-note">暂无 OOC 纠偏记录。</p>';
}
$("#characterCorrections").addEventListener("click", (event) => {
  const button = event.target.closest("[data-correction-action]");
  if (!button) return;
  const item = button.closest("[data-correction-id]");
  const character = state.characters.find((person) => person.id === $("#characterId").value);
  const correction = character?.oocCorrections?.find((entry) => entry.id === item?.dataset.correctionId);
  if (!correction) return;
  if (button.dataset.correctionAction === "delete") {
    character.oocCorrections = character.oocCorrections.filter((entry) => entry.id !== correction.id);
    renderCorrections(character);
  } else {
    const value = item.querySelector("textarea").value.trim();
    if (!value) { showToast("纠偏内容不能为空"); return; }
    correction.text = value;
  }
  saveState(); showToast("纠偏记录已更新");
});

function openCharacterEditor(character = null) {
  const editing = Boolean(character);
  $("#characterModalTitle").textContent = editing ? "编辑人物" : "添加人物";
  $("#characterId").value = character?.id || "";
  $("#characterName").value = character?.name || "";
  $("#characterSubtitle").value = character?.subtitle || "";
  $("#characterSignature").value = character?.signature || "";
  renderCorrections(character);
  $("#characterPersona").value = character?.persona || "";
  $("#characterGreeting").value = character?.greeting || "";
  $("#showActionBubbles").checked = character?.showActionBubbles !== false;
  const selectedIds = character?.worldBookIds || [];
  $("#characterWorldBooks").innerHTML = state.worldBooks.length
    ? state.worldBooks.map((book) => `<label><input type="checkbox" value="${escapeHtml(book.id)}" ${selectedIds.includes(book.id) ? "checked" : ""} />${escapeHtml(book.name)}</label>`).join("")
    : '<p class="field-note">还没有世界书。请先在设置中创建。</p>';
  pendingAvatar = character?.avatar || "";
  setAvatar($("#characterAvatarPreview"), character?.name || "角", pendingAvatar);
  $("#deleteCharacter").style.visibility = editing ? "visible" : "hidden";
  openModal(els.characterModal);
}

function selectSettingsPanel(view) {
  $$(".tab-button").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === view));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === view));
}
function openSettings(view = "settings") {
  const standalone = view === "appearance" || view === "worldbooks";
  $("#settingsModalTitle").textContent = view === "appearance" ? "外观" : view === "worldbooks" ? "世界书" : "设置";
  $("#saveSettingsButton").textContent = view === "appearance" ? "保存外观" : view === "worldbooks" ? "完成" : "保存设置";
  $(".settings-tabs").hidden = standalone;
  selectSettingsPanel(standalone ? view : "identity");
  pendingUserAvatar = state.user.avatar;
  pendingBackground = state.settings.chatBackground;
  pendingHomeWallpaper = state.settings.homeWallpaper || "";
  pendingAppIcons = { ...(state.settings.appIcons || {}) };
  pendingCustomFontName = state.settings.customFontName || "";
  $("#userName").value = state.user.name;
  $("#userPersona").value = state.user.persona;
  setAvatar($("#userAvatarPreview"), state.user.name || "我", pendingUserAvatar);
  $("#apiProvider").value = state.settings.provider;
  const apiPreset = providerPresets[state.settings.provider] || providerPresets.custom;
  $("#apiEndpoint").value = state.settings.endpoint || apiPreset.endpoint;
  $("#apiKey").value = state.settings.apiKey;
  $("#apiModel").value = state.settings.model || apiPreset.model;
  $("#apiModel").placeholder = apiPreset.placeholder;
  $("#apiTemperature").value = state.settings.temperature;
  $("#temperatureValue").value = state.settings.temperature;
  $("#accentColor").value = state.settings.accent;
  $("#backgroundColor").value = state.settings.background;
  $("#panelColor").value = state.settings.panel;
  $("#incomingBubbleColor").value = state.settings.incomingBubbleColor;
  $("#actionBubbleColor").value = state.settings.actionBubbleColor;
  $("#textColor").value = state.settings.textColor;
  $("#mutedColor").value = state.settings.mutedColor;
  $("#outgoingTextColor").value = state.settings.outgoingTextColor;
  $("#bubbleRadius").value = state.settings.bubbleRadius;
  $("#radiusValue").value = `${state.settings.bubbleRadius}px`;
  $("#fontFamily").value = state.settings.font;
  $("#customFontStatus").textContent = pendingCustomFontName
    ? `当前字体：${pendingCustomFontName}。字体文件仅保存在当前设备。`
    : "支持 TTF、OTF、WOFF 和 WOFF2。字体文件仅保存在当前设备。";
  $("#homeWallpaperStatus").textContent = pendingHomeWallpaper ? "当前已设置桌面壁纸，可重新上传替换。" : "未选择图片，使用默认渐变壁纸。";
  renderAppIconSettings();
  renderWorldBookList();
  renderDefaultBooks();
  renderRelationships();
  openModal(els.settingsModal);
}

function renderDefaultBooks() {
  $("#defaultBookToggles").innerHTML = DEFAULT_BOOKS.map((book) =>
    `<div class="default-book"><label><input type="checkbox" data-default-book="${book.id}" ${state.enabledDefaultBooks.includes(book.id) ? "checked" : ""} />${book.name}</label>
    <details><summary>查看内容</summary><pre>${escapeHtml(defaultBookContents.get(book.id) || "正在载入内容……")}</pre></details></div>`).join("");
}
$("#defaultBookToggles").addEventListener("change", (event) => {
  const id = event.target.dataset.defaultBook;
  if (!id) return;
  state.enabledDefaultBooks = event.target.checked
    ? [...new Set([...state.enabledDefaultBooks, id])]
    : state.enabledDefaultBooks.filter((bookId) => bookId !== id);
  saveState();
});
defaultBooksReady.then(() => { if (!$("#settingsModal").hidden) renderDefaultBooks(); }).catch(() => {
  showToast("内置世界书载入失败，请刷新页面");
});

function renderWorldBookList() {
  const selectedId = $("#worldbookId").value;
  $("#worldbookList").innerHTML = state.worldBooks.length
    ? state.worldBooks.map((book) => `<button class="worldbook-item ${book.id === selectedId ? "is-selected" : ""}" type="button" data-worldbook-id="${escapeHtml(book.id)}">${escapeHtml(book.name)}</button>`).join("")
    : '<p class="field-note">还没有世界书。填写下方内容开始创建。</p>';
}

function personName(id) {
  return id === "__user__" ? (state.user.name || "我") : (state.characters.find((person) => person.id === id)?.name || "已删除角色");
}

function relationshipKey(first, second) {
  return [first, second].sort().join("|");
}

function renderRelationships() {
  const people = [{ id: "__user__", name: state.user.name || "我" }, ...state.characters];
  const options = people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  const first = $("#relationshipFirst").value;
  const second = $("#relationshipSecond").value;
  $("#relationshipFirst").innerHTML = options;
  $("#relationshipSecond").innerHTML = options;
  $("#relationshipFirst").value = people.some((person) => person.id === first) ? first : people[0].id;
  $("#relationshipSecond").value = people.some((person) => person.id === second) ? second : (people[1]?.id || people[0].id);
  $("#relationshipList").innerHTML = state.relationships.length
    ? state.relationships.map((item) => `<button class="worldbook-item" type="button" data-relationship-key="${escapeHtml(relationshipKey(item.first, item.second))}">${escapeHtml(personName(item.first))} · ${escapeHtml(personName(item.second))}　${escapeHtml((item.labels || []).join("、") || item.background?.slice(0, 26) || "背景设定")}</button>`).join("")
    : '<p class="field-note">还没有设置人物关系。</p>';
  updateRelationshipForm();
}

function updateRelationshipForm() {
  const first = $("#relationshipFirst").value;
  const second = $("#relationshipSecond").value;
  const item = state.relationships.find((entry) => relationshipKey(entry.first, entry.second) === relationshipKey(first, second));
  const presets = [...$(".relationship-types").querySelectorAll("input")];
  presets.forEach((input) => { input.checked = Boolean(item?.labels?.includes(input.value)); });
  $("#relationshipCustom").value = (item?.labels || []).filter((label) => !presets.some((input) => input.value === label)).join("、") || "";
  $("#relationshipBackground").value = item?.background || "";
  $("#firstCallsSecondLabel").textContent = `${personName(first)}如何称呼${personName(second)}`;
  $("#secondCallsFirstLabel").textContent = `${personName(second)}如何称呼${personName(first)}`;
  $("#firstCallsSecond").value = item?.addressing?.[first] || "";
  $("#secondCallsFirst").value = item?.addressing?.[second] || "";
  $("#deleteRelationship").hidden = !item;
}

$("#relationshipList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-relationship-key]");
  if (!button) return;
  const item = state.relationships.find((entry) => relationshipKey(entry.first, entry.second) === button.dataset.relationshipKey);
  if (!item) return;
  $("#relationshipFirst").value = item.first;
  $("#relationshipSecond").value = item.second;
  updateRelationshipForm();
});
["#relationshipFirst", "#relationshipSecond"].forEach((selector) => {
  $(selector).addEventListener("change", updateRelationshipForm);
});
$("#saveRelationship").addEventListener("click", () => {
  const first = $("#relationshipFirst").value;
  const second = $("#relationshipSecond").value;
  if (!first || !second || first === second) {
    showToast("请选择两个不同的人物");
    return;
  }
  const selected = [...$(".relationship-types").querySelectorAll("input:checked")].map((input) => input.value);
  const custom = $("#relationshipCustom").value.split(/[，,、]/).map((value) => value.trim()).filter(Boolean);
  const labels = [...new Set([...selected, ...custom])];
  const background = $("#relationshipBackground").value.trim();
  const addressing = { [first]: $("#firstCallsSecond").value.trim(), [second]: $("#secondCallsFirst").value.trim() };
  if (!labels.length && !background && !Object.values(addressing).some(Boolean)) {
    showToast("请填写关系、共同经历或称呼");
    return;
  }
  const existing = state.relationships.find((entry) => relationshipKey(entry.first, entry.second) === relationshipKey(first, second));
  if (existing) Object.assign(existing, { labels, background, addressing });
  else state.relationships.push({ first, second, labels, background, addressing });
  saveState();
  renderRelationships();
  showToast("人物关系已保存");
});
$("#deleteRelationship").addEventListener("click", () => {
  const first = $("#relationshipFirst").value;
  const second = $("#relationshipSecond").value;
  state.relationships = state.relationships.filter((entry) => relationshipKey(entry.first, entry.second) !== relationshipKey(first, second));
  saveState();
  renderRelationships();
  showToast("人物关系已删除");
});

function selectWorldBook(book = null) {
  $("#worldbookId").value = book?.id || "";
  $("#worldbookName").value = book?.name || "";
  $("#worldbookContent").value = book?.content || "";
  $("#deleteWorldbook").hidden = !book;
  renderWorldBookList();
}

$("#worldbookList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-worldbook-id]");
  if (button) selectWorldBook(state.worldBooks.find((book) => book.id === button.dataset.worldbookId));
});
$("#newWorldbook").addEventListener("click", () => selectWorldBook());
$("#saveWorldbook").addEventListener("click", () => {
  const name = $("#worldbookName").value.trim();
  const content = $("#worldbookContent").value.trim();
  if (!name || !content) {
    showToast("请填写世界书名称和内容");
    return;
  }
  const existing = state.worldBooks.find((book) => book.id === $("#worldbookId").value);
  if (existing) Object.assign(existing, { name, content });
  else state.worldBooks.push({ id: crypto.randomUUID(), name, content });
  selectWorldBook(existing || state.worldBooks.at(-1));
  saveState();
  showToast("世界书已保存");
});
$("#deleteWorldbook").addEventListener("click", () => {
  const book = state.worldBooks.find((item) => item.id === $("#worldbookId").value);
  if (!book || !confirm(`删除世界书“${book.name}”？`)) return;
  state.worldBooks = state.worldBooks.filter((item) => item.id !== book.id);
  state.characters.forEach((character) => {
    character.worldBookIds = (character.worldBookIds || []).filter((id) => id !== book.id);
  });
  selectWorldBook();
  saveState();
  showToast("世界书已删除");
});

function splitSpeech(text) {
  return text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
}

function actionText(text, speakerName) {
  const action = text.trim().replace(/^[（(]|[）)]$/g, "");
  return speakerName && !action.startsWith(speakerName) ? `${speakerName}：${action}` : action;
}
function speechAndActions(text, speakerName) {
  const parts = [];
  const pattern = /（([^（）]+)）|\(([^()]+)\)|\*([^*\n]+)\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push(...splitSpeech(text.slice(cursor, match.index)).map((line) => ({ type: "speech", text: line })));
    parts.push({ type: "action", text: actionText(match[1] || match[2] || match[3], speakerName) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(...splitSpeech(text.slice(cursor)).map((line) => ({ type: "speech", text: line })));
  return parts;
}

function parseReply(raw, speakerName = "") {
  const content = typeof raw === "string" ? raw.trim() : "";
  let parsed;
  try { parsed = JSON.parse(content.replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/g, "")); }
  catch { parsed = null; }
  const parts = Array.isArray(raw?.segments) || Array.isArray(parsed?.segments)
    ? (raw?.segments || parsed.segments)
    : content.split(/\n+/).filter(Boolean).map((line) => {
        const action = line.match(/^(?:\*([^*]+)\*|（([^）]+)）|\[动作\]\s*(.+))$/);
        return { type: action ? "action" : "speech", text: action ? (action[1] || action[2] || action[3]) : line };
      });
  const segments = parts.filter((part) => typeof part?.text === "string" && part.text.trim())
    .flatMap((part) => part.type === "action" ? [{ type: "action", text: actionText(part.text, speakerName) }] :
      speechAndActions(part.text, speakerName));
  if (!segments.length) segments.push({ type: "speech", text: content || "我在。" });
  return { content: segments.map((part) => part.type === "action" ? `[动作] ${part.text}` : part.text).join("\n"), segments };
}

function keepOnline(reply, speakerName) {
  const inPersonAction = /抱住|拥抱|牵起|牵住|握住.*手|亲吻|吻上|摸到|抚摸|递给|走到.*(?:身边|面前)|坐到.*(?:身边|旁边)|来到.*(?:身边|面前)|推门走进/;
  const inPersonSpeech = /(?:我|他|她)(?:现在|刚刚|已经)?(?:抱住了?你|牵住了?你|亲了?你|走到你身边|坐在你旁边|来到你面前|把.{0,12}递给你)/;
  const segments = reply.segments.map((segment) => {
    if (segment.type === "action" && inPersonAction.test(segment.text)) {
      return { type: "action", text: `${speakerName}：望着屏幕，停顿了一下` };
    }
    if (segment.type === "speech" && inPersonSpeech.test(segment.text)) {
      return { type: "speech", text: "我在屏幕这边呢" };
    }
    return segment;
  });
  return { segments, content: segments.map((part) => part.type === "action" ? `[动作] ${part.text}` : part.text).join("\n") };
}

function groupHistory(group, messages) {
  return messages.slice(-30).map((message) => ({
    role: "user",
    content: message.role === "system_notice" ? `系统提示：${noticeText(message)}` : `${message.role === "user" ? state.user.name || "我" : personName(message.speakerId)}：${message.content}`
  }));
}

async function requestReply(character, historyMessages = character.messages, group = null, guidance = "") {
  const { provider, endpoint, apiKey, model, temperature } = state.settings;
  if (state.enabledDefaultBooks.length) await defaultBooksReady;
  const proactive = pendingMessageCount({ messages: historyMessages }) === 0;
  const members = group?.memberIds.map((id) => state.characters.find((person) => person.id === id)).filter(Boolean) || [];
  if (!endpoint || !apiKey || !model) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const other = members.find((person) => person.id !== character.id);
    const relation = other && state.relationships.find((item) => relationshipKey(item.first, item.second) === relationshipKey(character.id, other.id));
    const recentSpeaker = group && historyMessages.at(-1)?.speakerId;
    const phrase = group ? (recentSpeaker && recentSpeaker !== character.id
      ? `${personName(recentSpeaker)}你刚说的我想了下\n我也想听听你的想法`
      : (other ? `${other.name}在吗\n${relation?.labels?.length ? `咱俩这${relation.labels.join("、")}关系` : ""}你怎么看` : "大家在吗？")) :
      (proactive ? `突然想起你了\n今天过得怎么样` : `嗯我看到了\n你想接着聊哪一部分`);
    return keepOnline(parseReply({ segments: [{ type: "speech", text: phrase }] }, character.name), character.name);
  }
  const systemPrompt = [
    `你正在扮演“${character.name}”。`,
    character.subtitle ? `核心特点：${character.subtitle}` : "",
    character.persona ? `人物设定：${character.persona}` : "",
    character.oocCorrections?.length ? `OOC 纠偏记录（今后始终遵守）：${character.oocCorrections.map((item) => item.text).join("；")}` : "",
    guidance ? `这次重回的纠偏说明：${guidance}` : "",
    ...state.worldBooks.filter((book) => (character.worldBookIds || []).includes(book.id)).map((book) => `世界书“${book.name}”：${book.content}`),
    ...DEFAULT_BOOKS.filter((book) => state.enabledDefaultBooks.includes(book.id))
      .map((book) => `内置世界书“${book.name}”：${defaultBookContents.get(book.id).replaceAll("{{char}}", character.name).replaceAll("{{user}}", state.user.name || "我")}`),
    ...state.relationships.map((item) => [
      `${personName(item.first)}与${personName(item.second)}的关系：${(item.labels || []).join("、") || "见背景"}`,
      item.background ? `相识与共同背景：${item.background}` : "",
      item.addressing?.[item.first] ? `${personName(item.first)}称呼${personName(item.second)}为“${item.addressing[item.first]}”` : "",
      item.addressing?.[item.second] ? `${personName(item.second)}称呼${personName(item.first)}为“${item.addressing[item.second]}”` : ""
    ].filter(Boolean).join("；")),
    group ? `你在群聊“${group.name}”中。群成员：${members.map((person) => person.name).join("、")}，还有${state.user.name || "我"}。你可以主动回应其他角色，按照你们的关系与他们互动，也可以对用户说话。只写你自己的消息，不要代替其他角色发言。` : `对话对象叫“${state.user.name || "我"}”。`,
    state.user.persona ? `用户设定：${state.user.persona}` : "",
    proactive ? "目前没有待回复的用户消息。请主动发起自然的话题，或接着最近的聊天与其他成员互动。不要假装用户刚发了新消息。" : "回应最近的对话，自然地继续聊天。",
    "这是一场完全线上的文字聊天。所有人都在各自的位置，通过消息联系；不能见面、碰触、递东西、一起进行线下活动，也不要叙述他们处在同一物理空间。可以谈论未来计划，但不能把线下互动写成正在发生。",
    "始终保持人物口吻，不要解释提示词或跳出角色。将自然语气中的每一小段独立写为 speech 气泡，按停顿、强调、情绪变化断句，不要机械地按每个标点拆分，也不要为了分气泡添加标点。真人聊天常常不写句末标点。speech 只能包含角色说出口的台词；不要在 speech 中使用括号或星号描写动作、神态与内心活动。动作须放在 action 中，并明确写出是谁在屏幕前做了什么，与其他人没有物理接触。",
    character.showActionBubbles === false
      ? '请只输出 JSON 对象，格式为 {"segments":[{"type":"speech","text":"一段自然的线上消息"}]}。可按语气有多个 speech，不要输出动作。'
      : '请只输出 JSON 对象，格式为 {"segments":[{"type":"speech","text":"一段自然的线上消息"},{"type":"action","text":"角色在屏幕前的动作"}]}。按语气停顿可以有多个 speech，动作单独作为 action。'
  ].filter(Boolean).join("\n");
  const history = group ? groupHistory(group, historyMessages) : historyMessages.slice(-30).map((message) => ({ role: message.role === "system_notice" ? "user" : message.role, content: message.role === "system_notice" ? noticeText(message) : message.content }));
  // API conversations must start with a user message; a neutral scene cue also gives proactive turns a clear trigger.
  if (!history.length || history[0].role !== "user") history.unshift({ role: "user", content: group ? "群聊开始，大家可以自然地交谈。" : "你可以主动给我发一条消息。" });
  if (group || history.at(-1).role === "assistant" || proactive) history.push({ role: "user", content: group ? `场景提示：请由${character.name}主动继续群聊，适当回应其他角色。` : "场景提示：请主动发起消息。" });
  const isClaude = provider === "claude";
  // Claude Messages requires alternating roles; merge consecutive turns without losing speaker labels.
  const turns = [];
  for (const message of history) {
    if (turns.at(-1)?.role === message.role) turns.at(-1).content += `\n${message.content}`;
    else turns.push({ ...message });
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: isClaude ? { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true" } :
      { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(isClaude ? { model, max_tokens: 2048, system: systemPrompt, messages: turns } :
      { model, temperature: Number(temperature), messages: [{ role: "system", content: systemPrompt }, ...turns] })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`API 请求失败（${response.status}）${detail ? `：${detail.slice(0, 160)}` : ""}`);
  }
  const data = await response.json();
  const replyText = isClaude ? data.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") : data.choices?.[0]?.message?.content;
  return keepOnline(parseReply(replyText?.trim() || "我刚才走神了一下，可以再说一次吗？", character.name), character.name);
}

function groupSpeakers(group) {
  const members = group.memberIds.map((id) => state.characters.find((person) => person.id === id)).filter(Boolean);
  if (!members.length) return [];
  const lastSpeaker = [...(group.messages || [])].reverse().find((message) => message.role === "assistant")?.speakerId;
  const firstIndex = lastSpeaker ? (members.findIndex((person) => person.id === lastSpeaker) + 1) % members.length : 0;
  const pending = [...(group.messages || [])].reverse().find((message) => message.role === "user")?.content || "";
  const mentioned = members.find((person) => pending.includes(`@${person.name}`));
  if (mentioned) return [mentioned, ...members.filter((person) => person.id !== mentioned.id).slice(0, 1)];
  return members.length > 1 ? [members[firstIndex], members[(firstIndex + 1) % members.length]] : members;
}

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const chat = activeChat();
  const content = els.input.value.trim();
  if (!chat || !content || isReplying) return;
  chat.messages ||= [];
  chat.messages.push({ role: "user", content, createdAt: Date.now() });
  els.input.value = ""; els.input.style.height = "auto";
  saveState(); render();
});

els.reply.addEventListener("click", async () => {
  const group = activeGroup();
  const chat = group || activeCharacter();
  if (!chat || isReplying) return;
  isReplying = true; replyingCharacterId = chatKey(chat); render();
  try {
    const speakers = group ? groupSpeakers(group) : [chat];
    for (const speaker of speakers) {
      const reply = await requestReply(speaker, chat.messages || [], group);
      chat.messages ||= [];
      chat.messages.push({ role: "assistant", speakerId: speaker.id, ...reply, createdAt: Date.now() });
      saveState(); render();
    }
  } catch (error) {
    showToast(error.message || "回复失败，请检查 API 设置");
  } finally {
    isReplying = false; replyingCharacterId = null; saveState(); render();
  }
});

function renderSelectionToolbar() {
  const count = selection?.keys.size || 0;
  $("#selectionToolbar").hidden = !count;
  $("#selectionCount").textContent = `已选择 ${count} 个气泡`;
  const selectedUser = [...(selection?.keys || [])].filter((key) => selection.chat.messages[Number(key.split(":")[0])]?.role === "user");
  $("#selectRecall").hidden = !selectedUser.length;
  $("#selectEdit").hidden = count !== 1 || selectedUser.length !== 1;
  $("#selectRetry").disabled = !count;
}
function exitSelection() { selection = null; $("#retryModal").hidden = true; render(); }
function selectBubble(bubble) {
  const index = Number(bubble.dataset.messageIndex);
  const segmentIndex = Number(bubble.dataset.segmentIndex);
  const chat = activeChat();
  if (!chat || isReplying || index < 0 || !chat.messages?.[index]) return;
  if (!selection || selection.chat !== chat) selection = { chat, group: activeGroup(), keys: new Set() };
  const key = `${index}:${segmentIndex}`;
  if (selection.keys.has(key)) selection.keys.delete(key);
  else selection.keys.add(key);
  if (!selection.keys.size) selection = null;
  render();
}
let longPressTriggered = false;
let pressOrigin = null;
els.messages.addEventListener("pointerdown", (event) => {
  const bubble = event.target.closest(".message-bubble[data-message-index]");
  if (!bubble || event.button !== 0 || selection) return;
  pressOrigin = { x: event.clientX, y: event.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { longPressTriggered = true; selectBubble(bubble); }, 550);
});
els.messages.addEventListener("pointermove", (event) => {
  if (pressOrigin && Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 10) clearTimeout(pressTimer);
});
["pointerup", "pointercancel", "pointerleave"].forEach((name) => els.messages.addEventListener(name, () => {
  clearTimeout(pressTimer); pressOrigin = null;
}));
els.messages.addEventListener("click", (event) => {
  if (longPressTriggered) { longPressTriggered = false; return; }
  const bubble = event.target.closest(".message-bubble[data-message-index]");
  if (selection && bubble) selectBubble(bubble);
});
els.messages.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest(".message-bubble[data-message-index]");
  if (!bubble) return;
  event.preventDefault(); clearTimeout(pressTimer);
  if (!longPressTriggered) { longPressTriggered = event.button !== 2; selectBubble(bubble); }
});
els.messages.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const bubble = event.target.closest(".message-bubble[data-message-index]");
  if (!bubble) return;
  event.preventDefault(); selectBubble(bubble);
});
let mentionTimer = null;
let mentionOrigin = null;
function mentionFromAvatar(avatar) {
  const group = activeGroup();
  const person = group && state.characters.find((item) => item.id === avatar.dataset.speakerId && group.memberIds.includes(item.id));
  if (!person) return;
  const input = els.input;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const mention = `@${person.name} `;
  input.value = input.value.slice(0, start) + mention + input.value.slice(end);
  input.focus(); input.setSelectionRange(start + mention.length, start + mention.length);
  input.dispatchEvent(new Event("input"));
  showToast(`已 @${person.name}`);
}
els.messages.addEventListener("pointerdown", (event) => {
  const avatar = event.target.closest(".mention-avatar[data-speaker-id]");
  if (!avatar || event.button !== 0) return;
  mentionOrigin = { x: event.clientX, y: event.clientY };
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => mentionFromAvatar(avatar), 550);
});
els.messages.addEventListener("pointermove", (event) => {
  if (mentionOrigin && Math.hypot(event.clientX - mentionOrigin.x, event.clientY - mentionOrigin.y) > 10) clearTimeout(mentionTimer);
});
["pointerup", "pointercancel", "pointerleave"].forEach((name) => els.messages.addEventListener(name, () => { clearTimeout(mentionTimer); mentionOrigin = null; }));
els.messages.addEventListener("contextmenu", (event) => {
  const avatar = event.target.closest(".mention-avatar[data-speaker-id]");
  if (!avatar) return;
  event.preventDefault(); clearTimeout(mentionTimer); mentionFromAvatar(avatar);
});
els.messages.addEventListener("keydown", (event) => {
  const avatar = event.target.closest(".mention-avatar[data-speaker-id]");
  if (!avatar || !["Enter", " "].includes(event.key)) return;
  event.preventDefault(); mentionFromAvatar(avatar);
});
$("#selectCancel").addEventListener("click", exitSelection);
function removeDirectReplies(chat, index) {
  let next = index + 1;
  while (["user", "system_notice"].includes(chat.messages[next]?.role)) next++;
  while (chat.messages[next]?.role === "assistant") chat.messages.splice(next, 1);
}
$("#selectDelete").addEventListener("click", () => {
  if (!selection || isReplying) return;
  const { chat, keys } = selection;
  const byMessage = new Map();
  for (const key of keys) {
    const [index, segmentIndex] = key.split(":").map(Number);
    if (!byMessage.has(index)) byMessage.set(index, new Set());
    byMessage.get(index).add(segmentIndex);
  }
  for (const [index, selectedSegments] of [...byMessage].sort((a, b) => b[0] - a[0])) {
    const message = chat.messages[index];
    if (!message) continue;
    if (message.role === "user") { removeDirectReplies(chat, index); chat.messages.splice(index, 1); continue; }
    const parts = message.segments?.length ? message.segments : [{ type: "speech", text: message.content }];
    const remaining = parts.filter((_, segmentIndex) => !selectedSegments.has(segmentIndex));
    if (!remaining.length) chat.messages.splice(index, 1);
    else {
      message.segments = remaining;
      message.content = remaining.map((part) => part.type === "action" ? `[动作] ${part.text}` : part.text).join("\n");
    }
  }
  selection = null; saveState(); render(); showToast("已删除消息及其直接回复，角色后续不会看到原消息");
});
$("#selectRecall").addEventListener("click", () => {
  if (!selection || isReplying) return;
  const { chat, keys } = selection;
  const indices = [...new Set([...keys].map((key) => Number(key.split(":")[0])))].sort((a, b) => b - a);
  for (const index of indices) if (chat.messages[index]?.role === "user") {
    chat.messages[index] = { role: "system_notice", content: "[user]撤回了一条消息", createdAt: Date.now() };
  }
  selection = null; saveState(); render(); showToast("已撤回，角色可以看到撤回提示");
});
$("#selectEdit").addEventListener("click", () => {
  if (!selection || selection.keys.size !== 1 || isReplying) return;
  const index = Number([...selection.keys][0].split(":")[0]);
  if (selection.chat.messages[index]?.role !== "user") return;
  editMessageIndex = index;
  $("#editedMessageContent").value = selection.chat.messages[index].content;
  openModal($( "#editMessageModal" ));
});
$("#editMessageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const chat = selection?.chat;
  const content = $("#editedMessageContent").value.trim();
  if (!chat || !content || chat.messages[editMessageIndex]?.role !== "user") return;
  chat.messages[editMessageIndex].content = content;
  removeDirectReplies(chat, editMessageIndex);
  selection = null; editMessageIndex = null;
  closeModals(); saveState(); render(); showToast("消息已修改，原消息的直接回复已移除");
});
$("#selectRetry").addEventListener("click", () => {
  if (!selection || $("#selectRetry").disabled) return;
  $("#retryGuidance").value = "";
  openModal($("#retryModal"));
});
$("#retryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selection || isReplying) return;
  const { chat, group, keys } = selection;
  const guidance = $("#retryGuidance").value.trim();
  const indices = [...new Set([...keys].map((key) => Number(key.split(":")[0])).map((index) => {
    if (chat.messages[index]?.role === "assistant") return index;
    const next = chat.messages.findIndex((message, later) => later > index && message.role === "assistant");
    return next < 0 ? chat.messages.length : next;
  }))].sort((a, b) => a - b);
  $("#retryModal").hidden = true;
  if (!indices.length) return;
  isReplying = true; replyingCharacterId = `${group ? "group" : "character"}:${chat.id}`; render();
  const corrected = new Set();
  try {
    for (const index of indices) {
      const old = chat.messages[index];
      const speaker = group ? state.characters.find((person) => person.id === old?.speakerId) || state.characters.find((person) => group.memberIds.includes(person.id)) : chat;
      if (!speaker) continue;
      const reply = await requestReply(speaker, chat.messages.slice(0, index), group, guidance);
      chat.messages[index] = { role: "assistant", speakerId: speaker.id, ...reply, createdAt: Date.now() };
      if (guidance && !corrected.has(speaker)) {
        speaker.oocCorrections ||= [];
        speaker.oocCorrections.push({ id: crypto.randomUUID(), text: guidance, createdAt: Date.now() });
        corrected.add(speaker);
      }
      saveState(); render();
    }
    showToast(guidance ? "已替换回复并保存纠偏" : "已替换回复");
  } catch (error) { showToast(error.message || "重回失败"); }
  finally { isReplying = false; replyingCharacterId = null; selection = null; saveState(); render(); }
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 150)}px`;
});
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

function updateGroupAvatarPreview() {
  const memberIds = [...$("#groupMembers").querySelectorAll("input:checked")].map((input) => input.value);
  paintGroupAvatar($("#groupAvatarPreview"), { memberIds, avatar: pendingGroupAvatar });
}
$("#groupMembers").addEventListener("change", updateGroupAvatarPreview);
$("#groupAvatarInput").addEventListener("change", async (event) => {
  const file = event.target.files[0]; event.target.value = "";
  if (file) await openCropEditor(file, "group");
});
$("#removeGroupAvatar").addEventListener("click", () => { pendingGroupAvatar = ""; updateGroupAvatarPreview(); });
function openGroupEditor(group = null) {
  $("#groupModalTitle").textContent = group ? "编辑群聊" : "发起群聊";
  $("#groupId").value = group?.id || "";
  $("#groupName").value = group?.name || "";
  pendingGroupAvatar = group?.avatar || "";
  $("#groupMembers").innerHTML = state.characters.map((person) =>
    `<label><input type="checkbox" value="${escapeHtml(person.id)}" ${group?.memberIds.includes(person.id) ? "checked" : ""} />${escapeHtml(person.name)}</label>`).join("") ||
    '<p class="field-note">先创建至少两个人物，再发起群聊。</p>';
  updateGroupAvatarPreview();
  $("#deleteGroup").style.visibility = group ? "visible" : "hidden";
  openModal($("#groupModal"));
}
$("#addGroup").addEventListener("click", () => openGroupEditor());
$("#groupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const memberIds = [...$("#groupMembers").querySelectorAll("input:checked")].map((input) => input.value);
  if (memberIds.length < 2) { showToast("请至少选择两位角色"); return; }
  const id = $("#groupId").value;
  const existing = state.groups.find((group) => group.id === id);
  const group = { id: id || crypto.randomUUID(), name: $("#groupName").value.trim() || memberIds.map(personName).join("、"), memberIds, avatar: pendingGroupAvatar, messages: existing?.messages || [] };
  if (existing) Object.assign(existing, group);
  else state.groups.unshift(group);
  state.activeGroupId = group.id;
  saveState(); closeModals(); render(); els.app.classList.add("show-chat"); showToast("群聊已保存");
});
$("#deleteGroup").addEventListener("click", () => {
  const group = state.groups.find((item) => item.id === $("#groupId").value);
  if (!group || !confirm(`删除群聊“${group.name}”及全部聊天记录？`)) return;
  state.groups = state.groups.filter((item) => item.id !== group.id);
  state.activeGroupId = null; saveState(); closeModals(); render(); showToast("群聊已删除");
});

$("#editBrand").addEventListener("click", () => {
  $("#brandTitleInput").value = state.brand.title;
  $("#brandSubtitleInput").value = state.brand.subtitle;
  openModal($("#brandModal"));
});
$("#brandForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.brand = { title: $("#brandTitleInput").value.trim() || defaults.brand.title,
    subtitle: $("#brandSubtitleInput").value.trim() || defaults.brand.subtitle };
  saveState(); closeModals(); render();
});
$("#addCharacter").addEventListener("click", () => openCharacterEditor());
$("#editCharacter").addEventListener("click", () => {
  const character = activeCharacter();
  const group = activeGroup();
  if (group) openGroupEditor(group);
  else if (character) openCharacterEditor(character);
});
$("#backToList").addEventListener("click", () => els.app.classList.remove("show-chat"));
$("#launchWechat").addEventListener("click", () => { showScreen("wechat"); render(); });
$("#launchSettings").addEventListener("click", () => openSettings("settings"));
$("#launchAppearance").addEventListener("click", () => openSettings("appearance"));
$("#launchWorldbooks").addEventListener("click", () => openSettings("worldbooks"));
const homeGrid = $(".home-apps");
let iconPressTimer = null;
let iconPress = null;
let iconDrag = null;
let suppressIconClick = false;
homeGrid.addEventListener("click", (event) => {
  if (!suppressIconClick) return;
  event.preventDefault(); event.stopImmediatePropagation(); suppressIconClick = false;
}, true);
homeGrid.addEventListener("pointerdown", (event) => {
  const button = event.target.closest(".home-app[data-app-id]");
  if (!button || event.button !== 0) return;
  iconPress = { button, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  clearTimeout(iconPressTimer);
  iconPressTimer = setTimeout(() => {
    if (!iconPress) return;
    iconDrag = iconPress;
    button.classList.add("is-dragging");
    homeGrid.setPointerCapture(event.pointerId);
  }, 500);
});
homeGrid.addEventListener("pointermove", (event) => {
  if (!iconPress) return;
  const dx = event.clientX - iconPress.x;
  const dy = event.clientY - iconPress.y;
  if (!iconDrag && Math.hypot(dx, dy) > 9) { clearTimeout(iconPressTimer); iconPress = null; return; }
  if (iconDrag) iconDrag.button.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
});
function finishIconDrag(event) {
  clearTimeout(iconPressTimer);
  if (iconDrag) {
    const button = iconDrag.button;
    const others = [...homeGrid.querySelectorAll(".home-app[data-app-id]")].filter((item) => item !== button);
    const target = others.reduce((best, item) => {
      const rect = item.getBoundingClientRect();
      const distance = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
      return !best || distance < best.distance ? { item, distance } : best;
    }, null)?.item;
    button.style.transform = "";
    button.classList.remove("is-dragging");
    if (target && event.type === "pointerup" && Math.hypot(event.clientX - iconDrag.x, event.clientY - iconDrag.y) > 24) {
      const order = normalizedHomeOrder().filter((id) => id !== button.dataset.appId);
      order.splice(order.indexOf(target.dataset.appId), 0, button.dataset.appId);
      state.homeAppOrder = order;
      saveState(); renderHomeApps();
    }
    suppressIconClick = true;
    setTimeout(() => { suppressIconClick = false; }, 100);
  }
  iconPress = null; iconDrag = null;
}
homeGrid.addEventListener("pointerup", finishIconDrag);
homeGrid.addEventListener("pointercancel", finishIconDrag);
homeGrid.addEventListener("contextmenu", (event) => { if (event.target.closest(".home-app")) event.preventDefault(); });
homeGrid.addEventListener("keydown", (event) => {
  const button = event.target.closest(".home-app[data-app-id]");
  if (!button || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const order = normalizedHomeOrder();
  const index = order.indexOf(button.dataset.appId);
  const next = index + (event.key === "ArrowLeft" ? -1 : 1);
  if (next < 0 || next >= order.length) return;
  [order[index], order[next]] = [order[next], order[index]];
  state.homeAppOrder = order; saveState(); renderHomeApps(); button.focus();
});
[$("#homeFromList"), $("#homeFromChat")].forEach((button) => button.addEventListener("click", () => showScreen("home")));
$("#searchCharacters").addEventListener("input", (event) => renderCharacters(event.target.value));
$("#openSettings").addEventListener("click", () => { showScreen("home"); openSettings("settings"); });

$$('.close-modal').forEach((button) => button.addEventListener("click", closeModals));
$$('.modal-backdrop').forEach((modal) => modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModals();
}));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#cropModal").hidden) closeCropEditor(); else closeModals(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && selection) exitSelection(); });

$("#characterAvatarInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) await openCropEditor(file, "character");
});
$("#removeCharacterAvatar").addEventListener("click", () => {
  pendingAvatar = "";
  setAvatar($("#characterAvatarPreview"), $("#characterName").value || "角", "");
});
$("#characterName").addEventListener("input", (event) => setAvatar($("#characterAvatarPreview"), event.target.value || "角", pendingAvatar));

els.characterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#characterId").value;
  const existing = state.characters.find((character) => character.id === id);
  const character = {
    id: id || crypto.randomUUID(),
    name: $("#characterName").value.trim(),
    subtitle: $("#characterSubtitle").value.trim(),
    signature: $("#characterSignature").value.trim(),
    oocCorrections: existing?.oocCorrections || [],
    persona: $("#characterPersona").value.trim(),
    greeting: $("#characterGreeting").value.trim(),
    showActionBubbles: $("#showActionBubbles").checked,
    avatar: pendingAvatar,
    worldBookIds: [...$("#characterWorldBooks").querySelectorAll("input:checked")].map((input) => input.value),
    messages: existing?.messages || []
  };
  if (existing) Object.assign(existing, character);
  else state.characters.unshift(character);
  state.activeId = character.id;
  state.activeGroupId = null;
  saveState();
  closeModals();
  render();
  els.app.classList.add("show-chat");
  showToast("人物已保存");
});

$("#deleteCharacter").addEventListener("click", () => {
  const id = $("#characterId").value;
  const character = state.characters.find((item) => item.id === id);
  if (!character || !confirm(`删除“${character.name}”以及全部聊天记录？`)) return;
  state.characters = state.characters.filter((item) => item.id !== id);
  state.relationships = state.relationships.filter((entry) => entry.first !== id && entry.second !== id);
  state.groups = state.groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((memberId) => memberId !== id) })).filter((group) => group.memberIds.length >= 2);
  if (!state.groups.some((group) => group.id === state.activeGroupId)) state.activeGroupId = null;
  state.activeId = state.characters[0]?.id || "";
  saveState();
  closeModals();
  render();
  showToast("人物已删除");
});

$$('.tab-button').forEach((button) => button.addEventListener("click", () => {
  selectSettingsPanel(button.dataset.tab);
}));

$("#apiTemperature").addEventListener("input", (event) => { $("#temperatureValue").value = event.target.value; });
const providerPresets = {
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-flash",
    placeholder: "例如 deepseek-flash"
  },
  claude: {
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-5",
    placeholder: "例如 claude-sonnet-5"
  },
  custom: {
    endpoint: "",
    model: "",
    placeholder: "填写接口支持的模型名称"
  }
};

$("#apiProvider").addEventListener("change", (event) => {
  const preset = providerPresets[event.target.value];
  $("#apiEndpoint").value = preset.endpoint;
  $("#apiModel").value = preset.model;
  $("#apiModel").placeholder = preset.placeholder;
  $("#modelChoices").replaceChildren(new Option("先拉取模型列表", ""));
  $("#modelChoices").disabled = true;
  $("#modelStatus").textContent = "填写接口地址和 Key 后，可以拉取可用模型。";
});

$("#fetchModels").addEventListener("click", async () => {
  const provider = $("#apiProvider").value;
  const endpoint = $("#apiEndpoint").value.trim();
  const apiKey = $("#apiKey").value.trim();
  const button = $("#fetchModels");
  const choices = $("#modelChoices");
  const status = $("#modelStatus");
  if (!endpoint || !apiKey) {
    status.textContent = "请先填写 API 地址和 Key。";
    return;
  }
  let modelsUrl;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("请使用 HTTPS 接口地址。");
    }
    if (provider === "claude") {
      modelsUrl = new URL("/v1/models", url).href;
    } else {
      url.pathname = url.pathname.replace(/\/(chat\/completions|completions)\/?$/, "").replace(/\/$/, "") + "/models";
      url.search = "";
      url.hash = "";
      modelsUrl = url.href;
    }
  } catch (error) {
    status.textContent = error.message || "接口地址格式有误。";
    return;
  }
  button.disabled = true;
  button.textContent = "正在拉取…";
  status.textContent = "正在读取模型列表…";
  try {
    const response = await fetch(modelsUrl, {
      headers: provider === "claude" ? {
        "Authorization": `Bearer ${apiKey}`,
        "anthropic-version": "2026-10-21",
        "anthropic-dangerous-direct-browser-access": "true"
      } : { "Authorization": `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    const result = await response.json();
    const models = [...new Set((result.data || []).map((item) => item.id).filter((id) => typeof id === "string"))].sort();
    if (!models.length) throw new Error("接口没有返回可用模型。");
    choices.replaceChildren(new Option("选择模型", ""), ...models.map((id) => new Option(id, id)));
    choices.disabled = false;
    status.textContent = `已找到 ${models.length} 个模型。也可以继续手动填写模型名称。`;
  } catch (error) {
    choices.replaceChildren(new Option("拉取失败，可手动填写", ""));
    choices.disabled = true;
    status.textContent = `${error.message}。如果浏览器提示跨域限制，请联系接口服务商开放 /models 访问。`;
  } finally {
    button.disabled = false;
    button.textContent = "拉取可用模型";
  }
});

$("#modelChoices").addEventListener("change", (event) => {
  if (event.target.value) $("#apiModel").value = event.target.value;
});
$("#bubbleRadius").addEventListener("input", (event) => { $("#radiusValue").value = `${event.target.value}px`; });

$("#customFontInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    $("#customFontStatus").textContent = "正在读取字体……";
    await installCustomFont(file);
    await writeAsset("customFont", file);
    pendingCustomFontName = file.name;
    $("#fontFamily").value = "custom";
    $("#customFontStatus").textContent = `已载入：${file.name}。保存设置后生效。`;
    showToast("字体已载入");
  } catch {
    $("#customFontStatus").textContent = "无法读取这个字体文件，请换一个 TTF、OTF、WOFF 或 WOFF2 文件。";
    showToast("字体文件读取失败");
  }
  event.target.value = "";
});

$("#removeCustomFont").addEventListener("click", async () => {
  await removeAsset("customFont");
  if (activeCustomFontFace) document.fonts.delete(activeCustomFontFace);
  activeCustomFontFace = null;
  pendingCustomFontName = "";
  if ($("#fontFamily").value === "custom") $("#fontFamily").value = "system";
  $("#customFontStatus").textContent = "自定义字体已移除。";
  showToast("自定义字体已移除");
});

$("#userAvatarInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) await openCropEditor(file, "user");
});
$("#removeUserAvatar").addEventListener("click", () => {
  pendingUserAvatar = "";
  setAvatar($("#userAvatarPreview"), $("#userName").value || "我", "");
});
$("#userName").addEventListener("input", (event) => setAvatar($("#userAvatarPreview"), event.target.value || "我", pendingUserAvatar));

$("#chatBackgroundInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  pendingBackground = await fileToDataUrl(file, 1600, 0.8);
  showToast("背景图片已选择，保存后生效");
});
$("#homeWallpaperInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
    pendingHomeWallpaper = await fileToDataUrl(file, 1200, 0.78);
    $("#homeWallpaperStatus").textContent = "已选择图片，保存设置后生效。";
  } catch (error) { showToast(error.message || "壁纸读取失败"); }
});
$("#clearHomeWallpaper").addEventListener("click", () => {
  pendingHomeWallpaper = "";
  $("#homeWallpaperStatus").textContent = "保存设置后恢复默认壁纸。";
});
$("#appIconSettings").addEventListener("change", async (event) => {
  const id = event.target.dataset.appIcon;
  const file = event.target.files?.[0];
  if (!id || !file) return;
  try {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
    pendingAppIcons[id] = await fileToDataUrl(file, 320, 0.85);
    renderAppIconSettings();
    showToast(`${HOME_APPS.find((app) => app.id === id).name}封面已选择，保存后生效`);
  } catch (error) { showToast(error.message || "图片读取失败"); }
});
$("#appIconSettings").addEventListener("click", (event) => {
  const id = event.target.closest("[data-reset-app-icon]")?.dataset.resetAppIcon;
  if (!id) return;
  delete pendingAppIcons[id];
  renderAppIconSettings();
});
$("#clearChatBackground").addEventListener("click", () => {
  pendingBackground = "";
  showToast("背景图片将在保存后移除");
});

els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.user = {
    name: $("#userName").value.trim() || "我",
    persona: $("#userPersona").value.trim(),
    avatar: pendingUserAvatar
  };
  state.settings = {
    ...state.settings,
    provider: $("#apiProvider").value,
    endpoint: $("#apiEndpoint").value.trim(),
    apiKey: $("#apiKey").value.trim(),
    model: $("#apiModel").value.trim(),
    temperature: Number($("#apiTemperature").value),
    accent: $("#accentColor").value,
    background: $("#backgroundColor").value,
    panel: $("#panelColor").value,
    incomingBubbleColor: $("#incomingBubbleColor").value,
    actionBubbleColor: $("#actionBubbleColor").value,
    textColor: $("#textColor").value,
    mutedColor: $("#mutedColor").value,
    outgoingTextColor: $("#outgoingTextColor").value,
    bubbleRadius: Number($("#bubbleRadius").value),
    font: $("#fontFamily").value,
    customFontName: pendingCustomFontName,
    chatBackground: pendingBackground,
    homeWallpaper: pendingHomeWallpaper,
    appIcons: pendingAppIcons
  };
  saveState();
  closeModals();
  render();
  showToast("设置已保存到当前设备");
});

$("#exportData").addEventListener("click", () => {
  const exportState = clone(state);
  exportState.settings.apiKey = "";
  const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `私语备份-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

$("#importData").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.characters)) throw new Error("文件格式不正确");
    state = {
      ...clone(defaults),
      ...imported,
      user: { ...defaults.user, ...(imported.user || {}) },
      settings: { ...defaults.settings, ...(imported.settings || {}) },
      worldBooks: Array.isArray(imported.worldBooks) ? imported.worldBooks : [],
      enabledDefaultBooks: Array.isArray(imported.enabledDefaultBooks) ? imported.enabledDefaultBooks : [],
      brand: { ...defaults.brand, ...(imported.brand || {}) },
      relationships: Array.isArray(imported.relationships) ? imported.relationships : [],
      groups: Array.isArray(imported.groups) ? imported.groups : [],
      activeGroupId: Array.isArray(imported.groups) && imported.groups.some((group) => group.id === imported.activeGroupId) ? imported.activeGroupId : null
    };
    saveState();
    closeModals();
    render();
    showToast("数据已导入");
  } catch (error) {
    showToast(error.message || "导入失败");
  }
  event.target.value = "";
});

$("#clearChats").addEventListener("click", () => {
  if (!confirm("清空所有人物的聊天记录？人物设定会保留。")) return;
  state.characters.forEach((character) => { character.messages = []; });
  state.groups.forEach((group) => { group.messages = []; });
  saveState();
  render();
  showToast("聊天记录已清空");
});

render();
restoreCustomFont().catch(() => {
  if (state.settings.font === "custom") {
    document.documentElement.style.setProperty("--font", 'Inter, ui-sans-serif, sans-serif');
  }
});
