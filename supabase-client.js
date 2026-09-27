// ============================================================
// REPLACE THESE TWO VALUES before doing anything else.
// Get them from Supabase dashboard -> Project Settings -> API
// ============================================================
const SUPABASE_URL = "https://flhtfhburynhpedujsrx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BqeF52y5d57hONWrr-2Vag_QgE69dMw";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Service workers require HTTPS in production (localhost is allowed for development).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("App shell could not be installed for offline use:", error);
    });
  });
}

// Redirect helper: if not logged in, bounce to login page.
// Call this at the top of student.html and admin.html.
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
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}
