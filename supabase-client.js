// ============================================================
// REPLACE THESE TWO VALUES before doing anything else.
// Get them from Supabase dashboard -> Project Settings -> API
// ============================================================
const SUPABASE_URL = "https://flhtfhburynhpedujsrx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BqeF52y5d57hONWrr-2Vag_QgE69dMw";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function showSrmAuthError(messageElement, error) {
  messageElement.textContent = error.message || "SRM sign in failed. Try again.";
  messageElement.className = "error";
  // Some running server versions return the message without its structured code.
  // Keep the recovery action available from the session-limit message itself.
  const needsSessionHelp = error.code === "concurrent_sessions" || /session limit/i.test(error.message || "");
  if (!needsSessionHelp) return;

  const openAcademiaButton = document.createElement("button");
  openAcademiaButton.type = "button";
  openAcademiaButton.className = "secondary";
  openAcademiaButton.textContent = "Open SRM Academia in a new tab";
  openAcademiaButton.addEventListener("click", () => {
    window.open("https://academia.srmist.edu.in/", "_blank", "noopener,noreferrer");
  });
  messageElement.append(document.createElement("br"), openAcademiaButton);
}

async function requestSrmAuthToken(email, password) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch("/api/auth/srm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: controller.signal
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The sign-in server returned an invalid response. Restart it and try again.");
    }
    if (!response.ok) {
      const error = new Error(result.error || "SRM sign in failed.");
      error.code = result.code;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("SRM verification timed out. Check your connection and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Service workers require HTTPS in production (localhost is allowed for development).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("App shell could not be installed for offline use:", error);
    });
  });
}

// Redirect helper: persistent developer sessions rely on the live profile role.
// Other SRM users must verify again after the 12-hour window.
async function requireAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  if (!session.user.email?.trim().toLowerCase().endsWith("@srmist.edu.in")) {
    await supabaseClient.auth.signOut();
    window.location.href = "index.html?error=srm-email-required";
    return null;
  }
  const verifiedAt = Number(session.user.app_metadata?.srm_academia_verified_at);
  const twelveHours = 12 * 60 * 60 * 1000;
  if (!verifiedAt || Date.now() - verifiedAt > twelveHours || verifiedAt > Date.now() + 60_000) {
    const profile = await getMyProfile(session.user.id);
    if (profile?.role !== "developer") {
      await supabaseClient.auth.signOut();
      window.location.href = "index.html?error=srm-verification-required";
      return null;
    }
  }
  return session;
}

// Fetch the logged-in user's profile row (contains role).
async function getMyProfile(userId) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) {
    console.error("Failed to load profile:", error);
    return null;
  }
  return data;
}

async function logout() {
  sessionStorage.removeItem("srmFixitStaffReauth");
  sessionStorage.removeItem("srmFixitDeveloperReauth");
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}
