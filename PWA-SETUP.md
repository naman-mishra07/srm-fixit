# SRM-FixIt PWA setup

## Run locally

Open the project through a local web server (for example, VS Code Live Server) at `http://localhost` or `http://127.0.0.1`. Do not open the HTML files with `file://`; service workers require a secure context. The PWA files are `manifest.webmanifest`, `sw.js`, `pwa-install.js`, and the icons in `icons/`.

## Install on a phone

The phone must be able to reach the app at an HTTPS address. After deploying the project to an HTTPS static host:

- **Android:** Open the site in Chrome and tap **Install SRM-FixIt** or use Chrome's **Install app** menu item.
- **iPhone/iPad:** Open the site in Safari, tap **Share**, then **Add to Home Screen**.

On desktop Chrome, **Open in app** means Chrome already has an installed app for this site; use it to launch the standalone app. The page only shows its own install button when Chrome provides a real install prompt.

Add the deployed HTTPS address to Supabase Auth's allowed redirect URLs so email confirmation links return to the app.

The service worker caches the app shell so the installed app can open offline. Sign-in, ticket submission, ticket loading, and status updates still require an internet connection.
