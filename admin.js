const $ = (selector) => document.querySelector(selector);
const HOUR = 60 * 60 * 1000;
const CATEGORY = {
  wifi: "WiFi", furniture: "Furniture", ac: "AC", electrical: "Electrical",
  smartboards_mics: "Smartboards & Mics", plumbing: "Plumbing", cleaning: "Cleaning"
};
const STATUS = { open: "Open", in_progress: "In Progress", awaiting_confirmation: "Awaiting Confirmation", resolved: "Resolved", rejected: "Rejected" };
const STAFF_STATUS = { open: "Open", in_progress: "In Progress", rejected: "Rejected" };
let tickets = [];
let staff = [];
let profiles = new Map();
let statusEvents = [];
let assignmentEvents = [];
let resolutionEvents = [];
let resolutionPhotoUrls = new Map();
let resolutionSchemaReady = false;
let duplicateCounts = new Map();
let selected = new Set();
let freshIds = new Set();
let drawerTicketId = null;
let hasLoaded = false;
let isLoading = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function safePhotoUrl(value) {
  try {
    const url = new URL(value);
    const projectHost = new URL(SUPABASE_URL).host;
    if (url.protocol !== "https:" || url.host !== projectHost
      || !url.pathname.includes("/storage/v1/object/public/ticket-photos/")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error-toast", isError);
  element.classList.remove("on");
  void element.offsetWidth;
  element.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("on"), 3200);
}

function locationText(ticket) {
  return `${ticket.building || "Building not set"}, ${ticket.floor || "Floor not set"}`
    + (ticket.is_common_area ? " (Common Area)" : `, Room ${ticket.room_number || "—"}`);
}

function elapsedLabel(start, end = Date.now()) {
  const hours = Math.max(0, Math.floor((new Date(end) - new Date(start)) / HOUR));
  if (hours < 1) return "<1h";
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function isActive(ticket) {
  return ticket.status === "open" || ticket.status === "in_progress" || ticket.status === "awaiting_confirmation";
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString([], {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  });
}

function profileName(id, fallback = "Unknown") {
  return id ? profiles.get(id)?.full_name || fallback : fallback;
}

function resolutionEmailLink(ticket) {
  const profile = profiles.get(ticket.student_id);
  if (!profile?.college_email || ticket.status !== "resolved") return "";
  const subject = "SRM-FixIt: Your maintenance issue has been resolved";
  const body = `Hello ${profile.full_name || "there"},\n\nYour ${CATEGORY[ticket.category] || ticket.category} issue at ${locationText(ticket)} has been marked as resolved.\n\nRegards,\nSRM-FixIt Maintenance Team`;
  return `mailto:${encodeURIComponent(profile.college_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function init() {
  const session = await requireAuth();
  if (!session) return;
  const profile = await getMyProfile(session.user.id);
  if (!profile || !["admin", "developer"].includes(profile.role)) {
    window.location.href = "student.html";
    return;
  }
  if (profile.role === "admin" && sessionStorage.getItem("srmFixitStaffReauth") !== session.user.id) {
    window.location.href = "staff-login.html";
    return;
  }

  // Harmless readiness probe: the Phase 7 function validates the empty note
  // before reading or changing a ticket. A missing RPC is the common setup issue.
  const probe = await supabaseClient.rpc("admin_submit_ticket_resolution", {
    target_ticket_id: "00000000-0000-0000-0000-000000000000",
    target_resolution_note: "",
    target_evidence_path: null
  });
  const probeMessage = probe.error?.message || "";
  resolutionSchemaReady = !probe.error || !/schema cache|could not find (the )?function|PGRST202/i.test(probeMessage);

  document.querySelectorAll(".switcher [data-l]").forEach((button) => {
    button.addEventListener("click", () => {
      document.body.dataset.layout = button.dataset.l;
      document.querySelectorAll(".switcher [data-l]").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      slideSwitcher();
    });
  });
  ["q", "so", "fs", "fc", "fb"].forEach((id) => {
    const element = $(`#${id}`);
    element.addEventListener(id === "q" ? "input" : "change", render);
  });
  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#ba").addEventListener("change", bulkAssign);
  $("#bs").addEventListener("change", bulkStatus);
  $(".switcher [data-act='refresh']").addEventListener("click", () => refreshData(false));
  $("#pill").addEventListener("click", showNewTickets);

  $("#fs").innerHTML += Object.entries(STATUS).filter(([value]) => value !== "resolved").map(([value, label]) =>
    `<option value="${value}">${label}</option>`).join("");
  $("#fc").innerHTML += Object.entries(CATEGORY).map(([value, label]) =>
    `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  $("#ba").innerHTML = '<option value="">Assign selected…</option><option value="_">Unassigned</option>';
  $("#bs").innerHTML = '<option value="">Set status…</option>'
    + Object.entries(STAFF_STATUS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $(".switcher").insertAdjacentHTML("afterbegin", '<i class="slider" aria-hidden="true"></i>');
  await refreshData(false);
  slideSwitcher();
  window.addEventListener("resize", slideSwitcher);
  document.fonts?.ready.then(slideSwitcher);
  window.setInterval(() => refreshData(true), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshData(true);
  });
}

async function refreshData(detectNew) {
  if (isLoading) return;
  isLoading = true;
  const ticketResult = await supabaseClient.from("tickets").select("*").order("created_at", { ascending: false });
  if (ticketResult.error) {
    isLoading = false;
    if (!hasLoaded) {
      $("#ticketList").innerHTML = `<p class="error">Could not load tickets: ${escapeHtml(ticketResult.error.message)}</p>`;
      $("#an").innerHTML = `<p class="error">Could not load analytics.</p>`;
    } else toast(`Refresh failed: ${ticketResult.error.message}`, true);
    return;
  }

  const nextTickets = ticketResult.data || [];
  if (detectNew && hasLoaded) {
    const previous = new Set(tickets.map((ticket) => ticket.id));
    for (const ticket of nextTickets) if (!previous.has(ticket.id)) freshIds.add(ticket.id);
    if (freshIds.size) {
      const pill = $("#pill");
      pill.textContent = `${freshIds.size} new ticket${freshIds.size === 1 ? "" : "s"} · Show`;
      pill.style.display = "block";
    }
  }
  tickets = nextTickets;
  selected = new Set([...selected].filter((id) => tickets.some((ticket) => ticket.id === id)));

  const [profileResult, statusResult, assignmentResult, duplicateResult, resolutionResult] = await Promise.all([
    supabaseClient.from("profiles").select("id, full_name, role, college_email, registration_number"),
    supabaseClient.from("ticket_status_events")
      .select("id, ticket_id, old_status, new_status, created_at, changed_by")
      .order("created_at", { ascending: false }).limit(500),
    supabaseClient.from("ticket_assignment_events")
      .select("id, ticket_id, previous_assignee_id, new_assignee_id, changed_by, created_at")
      .order("created_at", { ascending: false }).limit(500),
    supabaseClient.rpc("get_active_duplicate_ticket_groups"),
    supabaseClient.from("ticket_resolution_events")
      .select("id, ticket_id, event_type, resolution_note, evidence_path, reason, created_at, actor_id")
      .order("created_at", { ascending: false }).limit(500)
  ]);
  if (profileResult.error) console.warn("Could not load profiles:", profileResult.error.message);
  profiles = new Map((profileResult.data || []).map((profile) => [profile.id, profile]));
  staff = (profileResult.data || []).filter((profile) => profile.role === "admin")
    .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  statusEvents = statusResult.data || [];
  assignmentEvents = assignmentResult.data || [];
  resolutionEvents = resolutionResult.data || [];
  resolutionSchemaReady = resolutionSchemaReady && !resolutionResult.error;
  const setupWarning = $("#setup-warning");
  setupWarning.hidden = resolutionSchemaReady;
  if (!resolutionSchemaReady) {
    setupWarning.textContent = "Completion submission is disabled because the Phase 7 Supabase migration is missing. Run phase7-resolution-confirmation.sql in Supabase SQL Editor, then refresh this page.";
    console.warn("Could not load resolution events:", resolutionResult.error.message);
  }
  resolutionPhotoUrls = new Map();
  await Promise.all([...new Set(resolutionEvents.map((event) => event.evidence_path).filter(Boolean))].map(async (path) => {
    const { data } = await supabaseClient.storage.from("ticket-resolution-evidence").createSignedUrl(path, 300);
    if (data?.signedUrl) resolutionPhotoUrls.set(path, data.signedUrl);
  }));
  duplicateCounts = new Map();
  if (duplicateResult.error) console.warn("Could not load duplicate groups:", duplicateResult.error.message);
  else for (const group of duplicateResult.data || []) {
    for (const ticketId of group.ticket_ids || []) duplicateCounts.set(ticketId, group.ticket_count);
  }

  updateSelectOptions();
  renderAnalytics();
  render();
  hasLoaded = true;
  isLoading = false;
}

function updateSelectOptions() {
  const selectedBuilding = $("#fb").value;
  const buildings = [...new Set(tickets.map((ticket) => ticket.building).filter(Boolean))].sort();
  $("#fb").innerHTML = '<option value="">All Buildings</option>' + buildings.map((building) =>
    `<option value="${escapeHtml(building)}" ${building === selectedBuilding ? "selected" : ""}>${escapeHtml(building)}</option>`).join("");
  const selectedStaff = $("#ba").value;
  $("#ba").innerHTML = '<option value="">Assign selected…</option><option value="_">Unassigned</option>'
    + staff.map((person) => `<option value="${escapeHtml(person.id)}" ${person.id === selectedStaff ? "selected" : ""}>${escapeHtml(person.full_name || "Admin")}</option>`).join("");
}

function renderAnalytics() {
  const now = Date.now();
  const active = tickets.filter(isActive);
  const overdue = active.filter((ticket) => now - new Date(ticket.created_at).getTime() > 48 * HOUR).length;
  const resolvedDurations = tickets.filter((ticket) => ticket.status === "resolved").map((ticket) => {
    const event = statusEvents.find((item) => item.ticket_id === ticket.id && item.new_status === "resolved");
    return event ? new Date(event.created_at) - new Date(ticket.created_at) : null;
  }).filter((duration) => duration !== null && duration >= 0);
  const avg = resolvedDurations.length
    ? elapsedLabel(0, resolvedDurations.reduce((sum, duration) => sum + duration, 0) / resolvedDurations.length)
    : "—";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = today.getTime() - (6 - index) * 24 * HOUR;
    const count = tickets.filter((ticket) => {
      const time = new Date(ticket.created_at).getTime();
      return time >= start && time < start + 24 * HOUR;
    }).length;
    return { label: new Date(start).toLocaleDateString([], { weekday: "short" }).slice(0, 1), count };
  });
  const maxDay = Math.max(1, ...days.map((day) => day.count));
  const hotspots = new Map();
  active.forEach((ticket) => {
    const label = `${ticket.building || "Unknown building"} · ${CATEGORY[ticket.category] || ticket.category}`;
    hotspots.set(label, (hotspots.get(label) || 0) + 1);
  });
  const topHotspots = [...hotspots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const maxHotspot = Math.max(1, ...topHotspots.map(([, count]) => count));
  $("#an").innerHTML = `<div class="tiles">
    <div class="tile"><b>${active.length}</b><span>Active tickets</span></div>
    <div class="tile"><b>${tickets.filter((ticket) => ticket.status === "resolved").length}</b><span>Resolved</span></div>
    <div class="tile ${overdue ? "warn" : ""}"><b>${overdue}</b><span>Open over 48 hours</span></div>
  </div><div class="split"><div><h3>Tickets per day</h3><div class="bars">${days.map((day) =>
    `<div><i style="height:${day.count / maxDay * 100}%" title="${day.count} tickets"></i>${day.label}</div>`).join("")}
  </div></div><div><h3>Hotspots</h3><div class="hot">${topHotspots.map(([label, count]) =>
    `<p>${escapeHtml(label)} <b>${count}</b><em style="width:${count / maxHotspot * 100}%"></em></p>`).join("")
    || "<p>No active tickets.</p>"}</div></div></div>`;
}

function render() {
  const query = $("#q").value.trim().toLowerCase();
  const status = $("#fs").value;
  const category = $("#fc").value;
  const building = $("#fb").value;
  const filtered = tickets.filter((ticket) => {
    const searchable = [ticket.description, ticket.room_number, ticket.building, ticket.floor,
      profileName(ticket.student_id), CATEGORY[ticket.category] || ticket.category].join(" ").toLowerCase();
    return ticket.status !== "resolved" && (!status || ticket.status === status) && (!category || ticket.category === category)
      && (!building || ticket.building === building) && (!query || searchable.includes(query));
  });
  const sort = $("#so").value;
  filtered.sort((a, b) => {
    if (sort === "old") return new Date(a.created_at) - new Date(b.created_at);
    if (sort === "dup") return (duplicateCounts.get(b.id) || 0) - (duplicateCounts.get(a.id) || 0)
      || new Date(b.created_at) - new Date(a.created_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });
  $("#ticketList").innerHTML = filtered.length
    ? filtered.map(renderTicket).join("")
    : `<p class="empty">${tickets.length ? "No tickets match these filters." : "No tickets have been submitted yet."}</p>`;
  $("#bn").textContent = `${selected.size} selected`;
  $("#bulk").classList.toggle("visible", selected.size > 0);
  if (drawerTicketId) renderDrawer(drawerTicketId);
}

function renderTicket(ticket) {
  const status = STATUS[ticket.status] ? ticket.status : "open";
  const age = Date.now() - new Date(ticket.created_at).getTime();
  const duplicateCount = duplicateCounts.get(ticket.id) || 0;
  const photo = safePhotoUrl(ticket.photo_url);
  const reporter = profiles.get(ticket.student_id);
  const emailLink = resolutionEmailLink(ticket);
  const id = escapeHtml(ticket.id);
  return `<article class="ticket ${freshIds.has(ticket.id) ? "fresh" : ""}" data-id="${id}">
    <label class="pick"><input type="checkbox" data-act="pick" aria-label="Select ticket" ${selected.has(ticket.id) ? "checked" : ""}></label>
    ${photo ? `<img src="${escapeHtml(photo)}" alt="Ticket photo" loading="lazy">` : '<div class="photo-empty">No photo</div>'}
    <div class="ticket-body"><div><strong>${escapeHtml(CATEGORY[ticket.category] || ticket.category)}</strong>
      <span class="badge badge-${status}">${STATUS[status]}</span><span class="age ${isActive(ticket) && age > 48 * HOUR ? "late" : ""}">${ticket.status === "resolved" ? "Resolved" : ticket.status === "awaiting_confirmation" ? "Waiting for reporter" : elapsedLabel(ticket.created_at) + (isActive(ticket) ? " open" : "")}</span></div>
      <div class="ticket-meta">${escapeHtml(locationText(ticket))}</div>
      <div class="ticket-meta">Reported by: ${escapeHtml(profileName(ticket.student_id))}</div>
      ${reporter?.college_email ? `<div class="ticket-meta">SRM email: <a class="reporter-email" href="mailto:${escapeHtml(reporter.college_email)}">${escapeHtml(reporter.college_email)}</a></div>` : ""}
      ${reporter?.registration_number ? `<div class="ticket-meta">Student registration number: ${escapeHtml(reporter.registration_number)}</div>` : ""}
      ${emailLink ? `<a class="resolution-email" href="${escapeHtml(emailLink)}">Draft resolution email</a>` : ""}
      <div class="ticket-meta">Assigned to: ${escapeHtml(profileName(ticket.assigned_to, "Unassigned"))}</div>
      ${ticket.description ? `<div class="ticket-meta description">${escapeHtml(ticket.description)}</div>` : ""}
      <div class="ticket-meta">Submitted ${escapeHtml(displayDate(ticket.created_at))}</div>
      ${duplicateCount > 1 ? `<div class="possible-duplicate">Potential duplicate · ${duplicateCount} active reports at this location</div>` : ""}
      <button class="ghost detail-button" data-act="details">Details & history</button>
      ${["open", "in_progress"].includes(ticket.status) ? `<section class="resolution-form"><strong>Finish this job</strong><label for="resolution-note-${id}">What was fixed?</label><textarea id="resolution-note-${id}" data-resolution-note maxlength="1000" placeholder="Describe the repair or action taken (required)" ${resolutionSchemaReady ? "" : "disabled"}></textarea><label for="resolution-photo-${id}">After photo (optional)</label><input id="resolution-photo-${id}" data-resolution-photo type="file" accept="image/jpeg,image/png,image/webp" ${resolutionSchemaReady ? "" : "disabled"}><button data-act="submit-resolution" ${resolutionSchemaReady ? "" : "disabled"}>${resolutionSchemaReady ? "Submit for reporter confirmation" : "Apply Phase 7 migration to enable"}</button></section>` : ""}
      ${resolutionEvents.filter((event) => event.ticket_id === ticket.id).map((event) => `<div class="resolution-note"><strong>${event.event_type === "submitted" ? "Staff completion note" : event.event_type === "confirmed" ? "Reporter confirmed" : "Reporter reopened"}</strong>${event.resolution_note ? `<p>${escapeHtml(event.resolution_note)}</p>` : ""}${event.reason ? `<p>Reason: ${escapeHtml(event.reason)}</p>` : ""}${event.evidence_path && resolutionPhotoUrls.has(event.evidence_path) ? `<a href="${escapeHtml(resolutionPhotoUrls.get(event.evidence_path))}" target="_blank" rel="noopener">View after photo</a>` : ""}</div>`).join("")}
      <label class="assignment-label" for="status-${id}">Ticket status</label>
      <select id="status-${id}" data-act="status">${status in STAFF_STATUS ? "" : `<option value="${status}" selected disabled>${STATUS[status] || status}</option>`}${Object.entries(STAFF_STATUS).map(([value, label]) =>
        `<option value="${value}" ${status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <label class="assignment-label" for="assignee-${id}">Assign maintenance staff</label>
      <select id="assignee-${id}" data-act="assign"><option value="">Unassigned</option>${staff.map((person) =>
        `<option value="${escapeHtml(person.id)}" ${person.id === ticket.assigned_to ? "selected" : ""}>${escapeHtml(person.full_name || "Admin")}</option>`).join("")}</select>
    </div></article>`;
}

function renderDrawer(ticketId) {
  const ticket = tickets.find((item) => item.id === ticketId);
  if (!ticket) return closeDrawer();
  const timeline = [
    { at: ticket.created_at, text: `Ticket submitted by ${profileName(ticket.student_id)}` },
    ...statusEvents.filter((event) => event.ticket_id === ticketId).map((event) => ({
      at: event.created_at,
      text: `${STATUS[event.old_status] || event.old_status} → ${STATUS[event.new_status] || event.new_status}`
        + (event.changed_by ? ` · ${profileName(event.changed_by, "Staff")}` : "")
    })),
    ...assignmentEvents.filter((event) => event.ticket_id === ticketId).map((event) => ({
      at: event.created_at,
      text: `Assigned to ${profileName(event.new_assignee_id, "Unassigned")}`
        + (event.changed_by ? ` · ${profileName(event.changed_by, "Staff")}` : "")
    })),
    ...resolutionEvents.filter((event) => event.ticket_id === ticketId).map((event) => ({
      at: event.created_at,
      text: `${event.event_type === "submitted" ? "Staff submitted completion" : event.event_type === "confirmed" ? "Reporter confirmed resolution" : "Reporter reopened ticket"}`
        + (event.resolution_note ? `: ${event.resolution_note}` : "") + (event.reason ? ` · Reason: ${event.reason}` : "")
    }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const photo = safePhotoUrl(ticket.photo_url);
  $("#drawer").innerHTML = `<button class="ghost" data-act="close">Close</button>
    <h2>${escapeHtml(CATEGORY[ticket.category] || ticket.category)} <span class="badge badge-${escapeHtml(ticket.status)}">${escapeHtml(STATUS[ticket.status] || ticket.status)}</span></h2>
    <p class="ticket-meta">${escapeHtml(locationText(ticket))}</p>
    ${ticket.description ? `<p>${escapeHtml(ticket.description)}</p>` : ""}
    ${photo ? `<img src="${escapeHtml(photo)}" alt="Ticket photo">` : ""}
    <h3>History</h3><ul class="tl">${timeline.map((item, index) =>
      `<li style="--k:${index}">${escapeHtml(item.text)}<small>${escapeHtml(displayDate(item.at))}</small></li>`).join("")}</ul>`;
  $("#drawer").classList.add("open");
  $("#scrim").classList.add("on");
}

function closeDrawer() {
  drawerTicketId = null;
  $("#drawer").classList.remove("open");
  $("#scrim").classList.remove("on");
}

async function changeStatus(ticketId, newStatus) {
  if (!STAFF_STATUS[newStatus]) return;
  const { error } = await supabaseClient.rpc("admin_set_ticket_status", { target_ticket_id: ticketId, target_status: newStatus });
  if (error) return toast(`Could not update status: ${error.message}`, true);
  toast(`Status changed to ${STATUS[newStatus]}`);
  await refreshData(false);
}

async function assignTicket(ticketId, staffId) {
  const { error } = await supabaseClient.rpc("admin_assign_ticket", {
    target_ticket_id: ticketId,
    target_staff_id: staffId || null
  });
  if (error) return toast(`Could not assign staff: ${error.message}`, true);
  toast(staffId ? `Assigned to ${profileName(staffId, "staff member")}` : "Ticket unassigned");
  await refreshData(false);
}

async function bulkStatus(event) {
  const value = event.target.value;
  event.target.value = "";
  if (!value || !selected.size) return;
  const ids = [...selected];
  if (!STAFF_STATUS[value]) return;
  const results = await Promise.all(ids.map((id) => supabaseClient.rpc("admin_set_ticket_status", { target_ticket_id: id, target_status: value })));
  const failures = results.filter((result) => result.error);
  selected.clear();
  toast(failures.length ? `${failures.length} of ${ids.length} status updates failed` : `${ids.length} tickets set to ${STATUS[value]}`, failures.length > 0);
  await refreshData(false);
}

async function bulkAssign(event) {
  const value = event.target.value;
  event.target.value = "";
  if (value === "" || !selected.size) return;
  const staffId = value === "_" ? null : value;
  const ids = [...selected];
  const results = await Promise.all(ids.map((id) => supabaseClient.rpc("admin_assign_ticket", {
    target_ticket_id: id, target_staff_id: staffId
  })));
  const failures = results.filter((result) => result.error);
  selected.clear();
  toast(failures.length ? `${failures.length} of ${ids.length} assignments failed` : `${ids.length} tickets updated`, failures.length > 0);
  await refreshData(false);
}

function handleClick(event) {
  const action = event.target.closest("[data-act]")?.dataset.act;
  const ticketId = event.target.closest("[data-id]")?.dataset.id;
  if (action === "details" && ticketId) {
    drawerTicketId = ticketId;
    renderDrawer(ticketId);
  } else if (action === "close") closeDrawer();
  else if (action === "logout") logout();
  else if (action === "submit-resolution" && ticketId) submitResolution(ticketId);
  else if (action === "clearsel") {
    selected.clear(); render();
  }
}

async function submitResolution(ticketId) {
  const card = document.querySelector(`[data-id="${CSS.escape(ticketId)}"]`);
  const noteInput = card?.querySelector("[data-resolution-note]");
  const photoInput = card?.querySelector("[data-resolution-photo]");
  const note = noteInput?.value.trim() || "";
  if (note.length < 5) return toast("Add a completion note (at least 5 characters).", true);
  const button = card.querySelector('[data-act="submit-resolution"]');
  button.disabled = true;
  let evidencePath = null;
  try {
    const file = photoInput?.files?.[0];
    if (file) {
      if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) throw new Error("Choose an image under 5 MB.");
      evidencePath = `${ticketId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabaseClient.storage.from("ticket-resolution-evidence").upload(evidencePath, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
    }
    const { error } = await supabaseClient.rpc("admin_submit_ticket_resolution", {
      target_ticket_id: ticketId, target_resolution_note: note, target_evidence_path: evidencePath
    });
    if (error) throw error;
    toast("Sent to the reporter for confirmation.");
    await refreshData(false);
  } catch (error) {
    if (evidencePath) await supabaseClient.storage.from("ticket-resolution-evidence").remove([evidencePath]);
    const detail = error.message || "Unknown error";
    const message = /admin_submit_ticket_resolution|schema cache|ticket_resolution_events/i.test(detail)
      ? "Completion needs the Phase 7 Supabase migration. Run phase7-resolution-confirmation.sql, then refresh."
      : /bucket not found|ticket-resolution-evidence/i.test(detail)
        ? "The private evidence bucket is missing. Run the Phase 7 Supabase migration, then retry."
        : `Could not submit completion: ${detail}`;
    toast(message, true);
    button.disabled = false;
  }
}

function handleChange(event) {
  const control = event.target;
  const action = control.dataset.act;
  const ticketId = control.closest("[data-id]")?.dataset.id;
  if (action === "pick" && ticketId) {
    control.checked ? selected.add(ticketId) : selected.delete(ticketId);
    render();
  } else if (action === "status" && ticketId) {
    changeStatus(ticketId, control.value);
  } else if (action === "assign" && ticketId) {
    assignTicket(ticketId, control.value);
  }
}

function showNewTickets() {
  freshIds.clear();
  $("#pill").style.display = "none";
  $("#q").value = "";
  $("#fs").value = "";
  $("#fc").value = "";
  $("#fb").value = "";
  $("#so").value = "new";
  render();
  window.scrollTo({ top: document.querySelector("#ticketList").offsetTop, behavior: "smooth" });
}

function slideSwitcher() {
  const activeButton = document.querySelector(".switcher [aria-pressed='true']");
  const slider = $(".slider");
  if (!activeButton || !slider) return;
  slider.style.left = `${activeButton.offsetLeft}px`;
  slider.style.width = `${activeButton.offsetWidth}px`;
}

init();
