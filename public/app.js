const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, activeView: "browse", location: null, activeConversation: null, categories: [] };
const pageMeta = {
  browse: ["DISCOVER", "Find what belongs to you"],
  "report-lost": ["CREATE REPORT", "Report a lost item"],
  "report-found": ["CREATE REPORT", "Report a found item"],
  visual: ["COMPUTER VISION", "Search with an image"],
  assistant: ["AI ASSISTANT", "Describe what happened"],
  messages: ["PRIVATE CHAT", "Conversations"],
  reports: ["YOUR ACTIVITY", "My reports"],
};

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }
function displayDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Date not specified"; }
function toast(message, kind = "success") { const node = $("#toast"); node.textContent = message; node.className = `toast visible ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 3500); }
function setLoading(button, loading) { if (!button) return; button.disabled = loading; button.dataset.label ||= button.textContent; button.textContent = loading ? "Working…" : button.dataset.label; }

function setAuthMode(mode) {
  const signingUp = mode === "signup";
  $("#loginForm").classList.toggle("hidden", signingUp);
  $("#signupForm").classList.toggle("hidden", !signingUp);
  $("#authTitle").textContent = signingUp ? "Create your account" : "Welcome back";
  $("#authSubtitle").textContent = signingUp ? "Start reporting, searching, and reconnecting people with their belongings." : "Sign in to manage your reports and matches.";
  $("#switchLabel").textContent = signingUp ? "Already have an account?" : "New here?";
  $("#switchAuth").textContent = signingUp ? "Sign in" : "Create an account";
  $("#switchAuth").dataset.mode = signingUp ? "login" : "signup";
}
function enterApp(user) {
  state.user = user;
  $("#authScreen").classList.add("hidden"); $("#appShell").classList.remove("hidden");
  $("#profileName").textContent = user.name; $("#profileInitial").textContent = user.name.slice(0, 1).toUpperCase();
  showView("browse"); loadNotifications();
}
async function showView(view) {
  state.activeView = view;
  $$(".view").forEach((node) => node.classList.toggle("hidden", node.id !== `${view}View`));
  $$(".nav-link[data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  const [kicker, title] = pageMeta[view]; $("#pageKicker").textContent = kicker; $("#pageTitle").textContent = title;
  if (view === "browse") await loadItems();
  if (view === "messages") await loadConversations();
  if (view === "reports") await loadMyReports();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function categoryOptions() { return `<option value="">Choose category</option>${state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`; }
async function initialise() {
  const { categories } = await api("/api/categories");
  state.categories = categories;
  $("#categoryFilter").insertAdjacentHTML("beforeend", categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join(""));
  $("#visualCategory").insertAdjacentHTML("beforeend", categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join(""));
  mountReport("lost"); mountReport("found");
  try { const { user } = await api("/api/me"); enterApp(user); } catch { setAuthMode("login"); }
}

$("#switchAuth").addEventListener("click", () => setAuthMode($("#switchAuth").dataset.mode));
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const form = new FormData(event.currentTarget); const { user } = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) }); enterApp(user); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});
$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const form = new FormData(event.currentTarget); const { user } = await api("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) }); enterApp(user); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});
$("#logoutButton").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); });
$$(".nav-link[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

function mountReport(type) {
  const form = $("#reportTemplate").content.firstElementChild.cloneNode(true);
  form.dataset.reportType = type; $(".category-select", form).innerHTML = categoryOptions();
  if (type !== "found") $(".found-only", form).classList.add("hidden");
  form.addEventListener("submit", submitReport);
  $(`#${type === "lost" ? "lost" : "found"}FormMount`).replaceChildren(form);
}
async function submitReport(event) {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); setLoading(button, true);
  try {
    const data = new FormData(form); data.append("reportType", form.dataset.reportType);
    const { item, matches } = await api("/api/items", { method: "POST", body: data });
    toast("Your report is live."); form.reset();
    if (matches.length) { showView("browse"); setTimeout(() => openDetail(item.id, matches), 200); } else showView("reports");
  } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
}

$("#searchForm").addEventListener("submit", (event) => { event.preventDefault(); loadItems(); });
$("#typeFilter").addEventListener("change", loadItems); $("#categoryFilter").addEventListener("change", loadItems);
$("#nearMeButton").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location is not available in this browser.", "error");
  navigator.geolocation.getCurrentPosition(({ coords }) => { state.location = { latitude: coords.latitude, longitude: coords.longitude }; toast("Showing reports within 8 km of you."); loadItems(); }, () => toast("Location permission was not granted.", "error"));
});
async function loadItems() {
  const params = new URLSearchParams();
  const q = $("#searchInput").value.trim(), type = $("#typeFilter").value, category = $("#categoryFilter").value;
  if (q) params.set("q", q); if (type) params.set("type", type); if (category) params.set("category", category);
  if (state.location) { params.set("latitude", state.location.latitude); params.set("longitude", state.location.longitude); params.set("radiusKm", "8"); }
  try { const [{ items }, stats] = await Promise.all([api(`/api/items?${params}`), api("/api/stats")]); renderItems(items, $("#itemGrid")); renderStats(stats); } catch (error) { toast(error.message, "error"); }
}
function renderStats(stats) { $("#stats").innerHTML = `<div><strong>${stats.total}</strong><span>active reports</span></div><div><strong>${stats.found}</strong><span>found items</span></div><div><strong>${stats.returned}</strong><span>returned</span></div>`; }
function renderItems(items, target, options = {}) {
  if (!items.length) { target.innerHTML = `<div class="empty-state"><span>⌕</span><h3>Nothing matched this search yet.</h3><p>Try a broader location, different keywords, or create a report for automatic matching.</p></div>`; return; }
  target.innerHTML = items.map((item) => cardHtml(item, options)).join("");
  $$("[data-item-id]", target).forEach((card) => card.addEventListener("click", () => openDetail(card.dataset.itemId)));
}
function cardHtml(item, options = {}) {
  const image = item.primaryImage ? `<img src="${escapeHtml(item.primaryImage)}" alt="${escapeHtml(item.title)}">` : `<span class="image-placeholder">${item.category === "Keys" ? "🔑" : "◌"}</span>`;
  const match = item.match ? `<span class="score">${item.match.score}% match</span>` : (item.visualScore !== undefined ? `<span class="score">${item.visualScore}% visual</span>` : "");
  const action = options.own ? `<span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>` : "";
  return `<article class="item-card" data-item-id="${item.id}"><div class="card-image">${image}<span class="report-type ${item.report_type}">${item.report_type}</span></div><div class="card-body"><div class="card-title-row"><h3>${escapeHtml(item.title)}</h3>${match || action}</div><p class="card-meta">${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</p><p class="card-location">⌖ ${escapeHtml(item.location_name)}</p><p class="card-description">${escapeHtml(item.description || "No extra description provided.")}</p></div></article>`;
}
async function openDetail(id, matchesFromCreate = null) {
  try {
    const { item } = await api(`/api/items/${id}`);
    const matches = matchesFromCreate || (await api(`/api/items/${id}/matches`)).matches;
    const isOwner = item.user_id === state.user.id;
    const gallery = item.images.length ? `<div class="detail-gallery">${item.images.map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText || item.title)}">`).join("")}</div>` : "";
    const matchHtml = matches.length ? `<section class="match-panel"><div class="section-label">SMART MATCHES</div><h3>Possible connections</h3>${matches.slice(0, 3).map((match) => `<button class="match-row" data-match-id="${match.id}"><strong>${escapeHtml(match.title)}</strong><span>${match.match.score}% · ${escapeHtml(match.match.reasons.join(", ") || "similar report")}</span></button>`).join("")}</section>` : "";
    const ownerControls = isOwner ? `<section class="owner-controls"><label>Report status<select id="statusSelect"><option value="open" ${item.status === "open" ? "selected" : ""}>Open</option><option value="matched" ${item.status === "matched" ? "selected" : ""}>Possible match</option><option value="claimed" ${item.status === "claimed" ? "selected" : ""}>Claimed</option><option value="returned" ${item.status === "returned" ? "selected" : ""}>Returned</option><option value="closed" ${item.status === "closed" ? "selected" : ""}>Closed</option></select></label><button id="saveStatus" class="button secondary">Update status</button><button id="deleteItem" class="text-button danger-text">Delete report</button></section>` : `<button id="messageOwner" class="button primary wide-button">Message ${escapeHtml(item.reporter_name)}</button>`;
    $("#detailContent").innerHTML = `${gallery}<div class="detail-content"><div class="detail-top"><span class="report-type ${item.report_type}">${item.report_type}</span><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div><h2>${escapeHtml(item.title)}</h2><p class="detail-description">${escapeHtml(item.description || "No description provided.")}</p><dl class="detail-list"><div><dt>Category</dt><dd>${escapeHtml(item.category)}</dd></div><div><dt>Location</dt><dd>⌖ ${escapeHtml(item.location_name)}</dd></div><div><dt>Date</dt><dd>${displayDate(item.occurred_at)}</dd></div><div><dt>Posted by</dt><dd>${escapeHtml(item.reporter_name)}</dd></div>${item.keywords?.length ? `<div><dt>Keywords</dt><dd>${item.keywords.map(escapeHtml).join(", ")}</dd></div>` : ""}</dl>${ownerControls}${matchHtml}</div>`;
    const dialog = $("#detailDialog"); dialog.showModal();
    $$("[data-match-id]", dialog).forEach((button) => button.addEventListener("click", () => openDetail(button.dataset.matchId)));
    $("#messageOwner")?.addEventListener("click", () => startConversation(item));
    $("#saveStatus")?.addEventListener("click", () => updateStatus(item.id));
    $("#deleteItem")?.addEventListener("click", () => deleteReport(item.id));
  } catch (error) { toast(error.message, "error"); }
}
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
async function updateStatus(id) { try { await api(`/api/items/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: $("#statusSelect").value }) }); toast("Status updated."); $("#detailDialog").close(); loadMyReports(); } catch (error) { toast(error.message, "error"); } }
async function deleteReport(id) { if (!confirm("Delete this report? This cannot be undone.")) return; try { await api(`/api/items/${id}`, { method: "DELETE" }); toast("Report deleted."); $("#detailDialog").close(); loadMyReports(); } catch (error) { toast(error.message, "error"); } }

$("#visualForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); setLoading(button, true);
  try { const { results, method } = await api("/api/visual-search", { method: "POST", body: new FormData(event.currentTarget) }); renderItems(results, $("#visualResults")); toast(`Results use ${method}.`); } catch (error) { toast(error.message, "error"); } finally { setLoading(button, false); }
});

$("#assistantForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("input", event.currentTarget), question = input.value.trim(); if (!question) return;
  addAssistantMessage(question, "user"); input.value = ""; const button = $("button", event.currentTarget); setLoading(button, true);
  try { const { answer, extractedKeywords, matches } = await api("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }); addAssistantMessage(`${answer}<div class="keyword-line">Searching for: ${extractedKeywords.map(escapeHtml).join(", ") || "general terms"}</div>`, "bot", true); if (matches.length) { const holder = document.createElement("div"); holder.className = "assistant-match-grid"; holder.innerHTML = matches.map((item) => `<button data-item-id="${item.id}"><strong>${escapeHtml(item.title)}</strong><span>${item.match.score}% match · ${escapeHtml(item.location_name)}</span></button>`).join(""); $("#assistantMessages").append(holder); $$("[data-item-id]", holder).forEach((node) => node.addEventListener("click", () => openDetail(node.dataset.itemId))); } } catch (error) { addAssistantMessage(escapeHtml(error.message), "bot"); } finally { setLoading(button, false); }
});
function addAssistantMessage(content, type, html = false) { const node = document.createElement("div"); node.className = `assistant-message ${type}`; if (html) node.innerHTML = content; else node.textContent = content; $("#assistantMessages").append(node); $("#assistantMessages").scrollTop = 1e6; }
$$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#assistantForm input").value = button.dataset.prompt; $("#assistantForm").requestSubmit(); }));

async function startConversation(item) { try { const { conversation } = await api("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: item.id }) }); $("#detailDialog").close(); await showView("messages"); await openConversation(conversation.id); } catch (error) { toast(error.message, "error"); } }
async function loadConversations() {
  try { const { conversations } = await api("/api/conversations"); const target = $("#conversationList"); target.innerHTML = conversations.length ? conversations.map((conversation) => `<button class="conversation ${state.activeConversation === conversation.id ? "selected" : ""}" data-conversation-id="${conversation.id}">${conversation.item_image ? `<img src="${escapeHtml(conversation.item_image)}" alt="">` : `<span>◌</span>`}<div><strong>${escapeHtml(conversation.counterpart_name)}</strong><small>${escapeHtml(conversation.item_title)}</small><p>${escapeHtml(conversation.last_message || "No messages yet")}</p></div></button>`).join("") : `<div class="empty-state small"><h3>No conversations yet.</h3><p>Open a report and choose “Message” to begin safely.</p></div>`; $$("[data-conversation-id]", target).forEach((node) => node.addEventListener("click", () => openConversation(node.dataset.conversationId))); if (state.activeConversation && conversations.some((c) => c.id === state.activeConversation)) await openConversation(state.activeConversation); } catch (error) { toast(error.message, "error"); }
}
async function openConversation(id) {
  state.activeConversation = id;
  try { const { messages } = await api(`/api/conversations/${id}/messages`); const target = $("#messagePane"); target.classList.remove("empty-pane"); target.innerHTML = `<div class="message-thread">${messages.map((message) => `<div class="message ${message.sender_id === state.user.id ? "mine" : ""}"><span>${escapeHtml(message.body)}</span><small>${escapeHtml(message.sender_name)} · ${displayDate(message.created_at)}</small></div>`).join("")}</div><form id="messageForm" class="message-form"><input name="body" maxlength="2000" placeholder="Write a message…" required><button class="button primary">Send</button></form>`; $("#messageForm").addEventListener("submit", (event) => sendMessage(event, id)); $(".message-thread", target).scrollTop = 1e6; } catch (error) { toast(error.message, "error"); }
}
async function sendMessage(event, id) { event.preventDefault(); const form = event.currentTarget; const input = $("input", form), body = input.value.trim(); if (!body) return; try { await api(`/api/conversations/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }); input.value = ""; await openConversation(id); } catch (error) { toast(error.message, "error"); } }

async function loadMyReports() {
  try { const { items } = await api("/api/items?limit=100"); renderItems(items.filter((item) => item.user_id === state.user.id), $("#myReports"), { own: true }); } catch (error) { toast(error.message, "error"); }
}
$("#editProfileButton").addEventListener("click", () => { $("#profileEditor").classList.toggle("hidden"); $("#profileForm [name=name]").value = state.user.name; $("#profileForm [name=email]").value = state.user.email; });
$("#profileForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const name = new FormData(event.currentTarget).get("name"); const { user } = await api("/api/me", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email: new FormData(event.currentTarget).get("email") }) }); state.user = user; $("#profileName").textContent = user.name; $("#profileInitial").textContent = user.name.slice(0, 1).toUpperCase(); $("#profileEditor").classList.add("hidden"); toast("Profile updated."); } catch (error) { toast(error.message, "error"); } });

$("#notificationButton").addEventListener("click", () => $("#notificationPanel").classList.toggle("hidden"));
async function loadNotifications() { try { const { notifications } = await api("/api/notifications"); const unread = notifications.filter((notification) => !notification.read_at).length; $("#notificationCount").textContent = unread; $("#notificationCount").classList.toggle("hidden", unread === 0); $("#notificationList").innerHTML = notifications.length ? notifications.map((notification) => `<div class="notification-item ${notification.read_at ? "" : "unread"}"><strong>${escapeHtml(notification.title)}</strong><p>${escapeHtml(notification.body || "")}</p><small>${displayDate(notification.created_at)}</small></div>`).join("") : `<p class="muted pad">Nothing new right now.</p>`; } catch { /* session can be changing */ } }
$("#readNotifications").addEventListener("click", async () => { await api("/api/notifications/read", { method: "PATCH" }); loadNotifications(); });

$("#socialButton").addEventListener("click", async () => {
  const query = $("#searchInput").value.trim() || prompt("What item should we look for in connected sources?"); if (!query) return;
  try { const result = await api("/api/social/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) }); const target = $("#socialResults"); target.classList.remove("hidden"); target.innerHTML = `<div class="social-head"><strong>Connected social sources</strong><span>${escapeHtml(result.limitation)}</span></div>${result.configured ? (result.results.length ? result.results.map((post) => `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer" class="social-post"><span>${post.source === "instagram" ? "◎" : "f"}</span><div><strong>${escapeHtml(post.title)}</strong><p>${escapeHtml(post.excerpt)}</p></div></a>`).join("") : `<p class="muted pad">No authorized posts matched those terms.</p>`) : `<p class="muted pad">${escapeHtml(result.limitation)}</p>`}`; } catch (error) { toast(error.message, "error"); }
});

$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
initialise().catch((error) => toast(error.message, "error"));


