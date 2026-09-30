import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import srmApi from "reddy-api-srm";

const { verifyUser, verifyPassword } = srmApi;
const app = express();
const port = Number(process.env.PORT || 3000);
const srmDomain = "@srmist.edu.in";
const nativeFetch = globalThis.fetch.bind(globalThis);

// The third-party Academia client does not set request timeouts itself.
globalThis.fetch = (input, options = {}) => {
  let isAcademia = false;
  try {
    const requestUrl = typeof input === "string" ? input : input.url;
    isAcademia = new URL(requestUrl).hostname === "academia.srmist.edu.in";
  } catch {
    // Leave non-URL fetch inputs to the native implementation.
  }
  if (isAcademia && !options.signal) {
    return nativeFetch(input, { ...options, signal: AbortSignal.timeout(8_000) });
  }
  return nativeFetch(input, options);
};

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  if (req.get("sec-fetch-site") === "cross-site") {
    return res.status(403).json({ error: "Cross-site requests are not accepted." });
  }
  const origin = req.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!['http:', 'https:'].includes(originUrl.protocol)
        || originUrl.host.toLowerCase() !== req.get("host")?.toLowerCase()) {
        return res.status(403).json({ error: "Cross-origin requests are not accepted." });
      }
    } catch {
      return res.status(403).json({ error: "Cross-origin requests are not accepted." });
    }
  }
  next();
});
app.use(express.json({ limit: "8kb", type: "application/json" }));

const supabaseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminClient = supabaseUrl && secretKey
  ? createClient(supabaseUrl, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    })
  : null;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Wait 15 minutes and try again." }
});
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  keyGenerator: (req) => req.body.email.trim().slice(0, 254).toLowerCase(),
  skip: (req) => typeof req.body?.email !== "string" || !req.body.email.trim(),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts for this account. Wait 15 minutes and try again." }
});

app.post("/api/auth/srm", authLimiter, accountLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!adminClient) {
    return res.status(503).json({ error: "SRM sign in is not configured on this server yet." });
  }

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email.endsWith(srmDomain) || email.length > 254 || !password || password.length > 1024) {
    return res.status(400).json({ error: "Enter a valid SRM email and password." });
  }

  try {
    const portalUsernames = [email, email.slice(0, email.indexOf("@"))];
    let userCheck;
    for (const portalUsername of portalUsernames) {
      userCheck = await verifyUser(portalUsername);
      if (userCheck?.error) {
        return res.status(502).json({ error: "SRM Academia could not be reached. Try again shortly." });
      }
      if (userCheck?.data?.identifier && userCheck?.data?.digest) break;
    }
    const identifier = userCheck?.data?.identifier;
    const digest = userCheck?.data?.digest;
    if (!identifier || !digest) {
      return res.status(401).json({ error: "SRM sign in failed. Check your email and password." });
    }

    // Do not use the package's login() helper: it may terminate other Academia sessions.
    // verifyPassword returns portal cookies, which are deliberately discarded here.
    const passwordCheck = await verifyPassword({ identifier, digest, password });
    if (passwordCheck?.error) {
      return res.status(502).json({ error: "SRM Academia could not be reached. Try again shortly." });
    }
    if (!passwordCheck?.isAuthenticated) {
      if (passwordCheck?.data?.captcha?.required) {
        return res.status(401).json({
          code: "captcha_required",
          error: "SRM sign in requires a CAPTCHA that this prototype cannot complete. Try again later."
        });
      }
      if (passwordCheck?.data?.isConcurrentLimit) {
        return res.status(401).json({
          code: "concurrent_sessions",
          error: "SRM Academia reports a session limit. Open Academia to review your sessions, then return and try again."
        });
      }
      return res.status(401).json({ error: "SRM sign in failed. Check your email and password." });
    }

    // Provision a FixIt auth identity only after Academia has verified the
    // credentials. Public Supabase signups can stay disabled; the service key
    // is used only on this server and never reaches the browser.
    let accountLink = await adminClient.auth.admin.generateLink({ type: "magiclink", email });
    let accountUser = accountLink.data?.user;
    if (!accountUser?.id) {
      const displayName = email.slice(0, email.indexOf("@")).trim().slice(0, 120);
      const { data: createdAccount } = await adminClient.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: displayName }
      });
      accountUser = createdAccount?.user;

      // A concurrent first login may have created the same auth user already.
      if (!accountUser?.id) {
        accountLink = await adminClient.auth.admin.generateLink({ type: "magiclink", email });
        accountUser = accountLink.data?.user;
      }
    }
    if (!accountUser?.id) {
      return res.status(503).json({ error: "SRM verified, but FixIt could not provision this account. Contact the administrator." });
    }

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", accountUser.id)
      .maybeSingle();
    if (profileError) {
      return res.status(503).json({ error: "FixIt could not check account access. Contact the administrator." });
    }
    if (!profile) {
      const displayName = String(accountUser.user_metadata?.full_name
        || accountUser.user_metadata?.name
        || email.slice(0, email.indexOf("@"))).trim().slice(0, 120);
      const { error: createProfileError } = await adminClient.from("profiles").insert({
        id: accountUser.id,
        full_name: displayName,
        role: "student",
        college_email: email
      });
      if (createProfileError) {
        return res.status(503).json({ error: "Your SRM account was verified, but FixIt could not create your profile. Contact the administrator." });
      }
    } else if (!["student", "admin", "developer"].includes(profile.role)) {
      return res.status(403).json({ error: "SRM verified, but this account is not enabled in FixIt. Contact the administrator." });
    }

    const { error: emailUpdateError } = await adminClient.from("profiles")
      .update({ college_email: email }).eq("id", accountUser.id);
    if (emailUpdateError) {
      return res.status(503).json({ error: "FixIt could not save your verified SRM email. Contact the administrator." });
    }

    const { error: metadataError } = await adminClient.auth.admin.updateUserById(accountUser.id, {
      app_metadata: {
        ...accountUser.app_metadata,
        srm_academia_verified_at: Date.now()
      }
    });
    if (metadataError) {
      return res.status(502).json({ error: "Could not start your FixIt session. Try again shortly." });
    }

    const sessionLink = await adminClient.auth.admin.generateLink({ type: "magiclink", email });
    if (sessionLink.error || !sessionLink.data?.properties?.hashed_token) {
      return res.status(502).json({ error: "Could not start your FixIt session. Try again shortly." });
    }
    res.json({ tokenHash: sessionLink.data.properties.hashed_token });
  } catch {
    // Never log request bodies, passwords, Academia cookies, or third-party error objects.
    res.status(502).json({ error: "SRM sign in is temporarily unavailable. Try again shortly." });
  }
});

app.patch("/api/profile/registration-number", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!adminClient) return res.status(503).json({ error: "Profile updates are not configured on this server." });

  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Sign in again to update your profile." });

  try {
    const { data: { user }, error: userError } = await adminClient.auth.getUser(match[1]);
    const email = user?.email?.trim().toLowerCase() || "";
    const verifiedAt = Number(user?.app_metadata?.srm_academia_verified_at);
    const verifiedRecently = verifiedAt && Date.now() - verifiedAt <= 12 * 60 * 60 * 1000
      && verifiedAt <= Date.now() + 60_000;
    if (userError || !user || !email.endsWith(srmDomain) || !verifiedRecently) {
      return res.status(401).json({ error: "Your SRM session expired. Sign in again to update your profile." });
    }

    const registrationNumber = typeof req.body?.registration_number === "string"
      ? req.body.registration_number.trim().toUpperCase() : "";
    if (registrationNumber && !/^[A-Z0-9/-]{4,30}$/.test(registrationNumber)) {
      return res.status(400).json({ error: "Enter a valid SRM registration number (4–30 letters, numbers, / or -)." });
    }

    const { data, error } = await adminClient.from("profiles")
      .update({ college_email: email, registration_number: registrationNumber || null })
      .eq("id", user.id).select("id").maybeSingle();
    if (error?.code === "23505") {
      return res.status(409).json({ error: "That registration number is already linked to another FixIt account." });
    }
    if (error || !data) return res.status(503).json({ error: "Could not save your profile details. Try again shortly." });
    res.json({ ok: true, registration_number: registrationNumber || null });
  } catch {
    res.status(503).json({ error: "Could not save your profile details. Try again shortly." });
  }
});

app.use((req, res, next) => {
  const privateFiles = ["/server.js", "/package.json", "/pnpm-lock.yaml", "/README.md"];
  if (privateFiles.includes(req.path) || req.path.startsWith("/node_modules/")
    || req.path.startsWith("/.git/") || req.path.endsWith(".sql")) {
    return res.sendStatus(404);
  }
  next();
});
app.use(express.static(process.cwd(), { dotfiles: "deny", etag: true, maxAge: "1h" }));
app.get("*path", (req, res) => res.sendFile(`${process.cwd()}/index.html`));

app.listen(port, "0.0.0.0", () => {
  console.log(`SRM-FixIt server listening on port ${port}`);
});
