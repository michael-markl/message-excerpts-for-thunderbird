/**
 * =====================================================================
 * Thunderbird Subject Excerpt Column (Background Script)
 * =====================================================================
 *
 * PURPOSE:
 * This background script acts as the "backend" for the Experiment API.
 * The Experiment API (implementation.js) handles all the DOM manipulation
 * but lacks access to standard WebExtension APIs.
 *
 * This script bridges that gap by:
 * 1. Initializing the Message Excerpt Experiment API.
 * 2. Listening for `onExcerptRequested` events fired from the UI.
 * 3. Fetching the message content using `browser.messages.listInlineTextParts`.
 * 4. Cleaning up and truncating the extracted plain text.
 * 5. Returning the processed excerpt back to the UI via `provideExcerpt`.
 * 
 * Note: Caching and deduping logic is handled by the UI script (implementation.js)
 * to minimize IPC overhead.
 * =====================================================================
 */

// Register wake-capable listeners synchronously on every event-page execution.
// onStartup ensures the UI is installed even before the first excerpt request.
browser.runtime.onStartup.addListener(() => {});

browser.messageExcerpts.onExcerptRequested.addListener(async (msgId, attemptId) => {
  let payload;
  try {
    // The Experiment owns retries and backoff across background lifetimes.
    const parts = await browser.messages.listInlineTextParts(msgId);
    let excerpt = "";
    const plain = parts?.find(part => part.contentType === "text/plain");
    if (plain?.content) {
      excerpt = plain.content;
    } else {
      const html = parts?.find(part => part.contentType === "text/html");
      if (html?.content) {
        excerpt = await browser.messengerUtilities.convertToPlainText(html.content);
      }
    }
    excerpt = excerpt.replace(/\s+/g, " ").trim();
    excerpt = excerpt.substring(0, 150) + (excerpt.length > 150 ? "..." : "");
    payload = { status: "success", excerpt };
  } catch (error) {
    console.error("Failed to get excerpt:", error);
    payload = { status: "failed" };
  }
  try {
    await browser.messageExcerpts.provideExcerpt(attemptId, payload);
  } catch (error) {
    // The Experiment retries if the page disappears before a reply arrives.
    console.error("Failed to deliver excerpt:", error);
  }
});

// Serialize initialization and preference updates so a slow initial read
// cannot overwrite a newer storage change.
let settingsUpdate = Promise.resolve().then(async () => {
  const preferences = await browser.storage.local.get({ excerptInThirdRow: true });
  await browser.messageExcerpts.setExcerptInThirdRow(preferences.excerptInThirdRow === true);
  await browser.messageExcerpts.init();
}).catch(error => console.error("Failed to initialize messageExcerpts API:", error));

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.excerptInThirdRow) return;
  settingsUpdate = settingsUpdate.then(async () => {
    await browser.messageExcerpts.setExcerptInThirdRow(
      changes.excerptInThirdRow.newValue !== false,
    );
    await browser.messageExcerpts.init();
  }).catch(error => console.error("Failed to update excerpt preferences:", error));
});
