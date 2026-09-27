(() => {
  let installPrompt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isStandalone) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "install-prompt";
  button.textContent = isIOS ? "How to add to Home Screen" : "Install SRM-FixIt";
  // Chromium can only show a real install flow through beforeinstallprompt.
  // Do not show a fake install button when the app is already installed or
  // the browser has not made it installable.
  button.hidden = !isIOS;
  document.body.append(button);

  const help = document.createElement("dialog");
  help.className = "install-help";
  help.innerHTML = `<h2>Install SRM-FixIt</h2><p></p><form method="dialog"><button class="secondary">Got it</button></form>`;
  if (isIOS) document.body.append(help);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.remove();
  });

  button.addEventListener("click", async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      button.hidden = true;
      return;
    }
    help.querySelector("p").textContent = "In Safari, tap Share, then choose Add to Home Screen.";
    help.showModal();
  });
})();
