async function main() {
  const toggle = document.getElementById("excerptInThirdRow");
  const status = document.getElementById("status");
  let statusHideTimeout = null;

  const setStatus = (text, autohide = true) => {
    clearTimeout(statusHideTimeout);
    status.textContent = text;
    if (autohide) {
      statusHideTimeout = setTimeout(() => {
        status.textContent = "";
      }, 2000);
    }
  };

  try {
    setStatus("Loading preferences...", false);
    const preferences = await browser.storage.local.get({
      excerptInThirdRow: true,
    });
    toggle.checked = preferences.excerptInThirdRow === true;
    toggle.disabled = false;
    setStatus("");
  } catch (error) {
    setStatus("Could not load preferences. Please reopen this page to try again.");
    console.error(error);
    return;
  }

  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      setStatus("Saving preferences...", false);
      await browser.storage.local.set({ excerptInThirdRow: toggle.checked });
      setStatus("Preferences saved.");
    } catch (error) {
      toggle.checked = !toggle.checked;
      setStatus("Could not save preferences. Please try again.");
      console.error(error);
    } finally {
      toggle.disabled = false;
    }
  });
}

main();
