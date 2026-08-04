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

async function main() {
  console.log("Message Excerpt Card View addon starting...");
  try {
    browser.messageExcerpts.onHeartbeat.addListener(() => {
      // Just receiving this event keeps the Event Page alive. No action needed.
    });

    const getPartsWithRetry = async (id, maxRetries = 5) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await browser.messages.listInlineTextParts(id);
        } catch (err) {
          if (attempt === maxRetries - 1) throw err;
          const baseDelay = 100 + Math.random() * 100; // Random base between 100ms and 200ms
          const delayMs = Math.pow(2, attempt) * baseDelay;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    };

    browser.messageExcerpts.onExcerptRequested.addListener(async (msgId) => {
      try {
        const parts = await getPartsWithRetry(msgId, 5);
        let excerpt = "";

        if (parts && parts.length > 0) {
          // Prefer text/plain if available
          let part = parts.find((p) => p.contentType === "text/plain");
          if (part && part.content) {
            excerpt = part.content;
          } else {
            // Fallback to text/html
            part = parts.find((p) => p.contentType === "text/html");
            if (part && part.content) {
              excerpt = await browser.messengerUtilities.convertToPlainText(
                part.content,
              );
            }
          }
        }

        // Cleanup excess whitespace and signatures
        excerpt = excerpt.replace(/\s+/g, " ").trim();

        excerpt =
          excerpt.substring(0, 150) + (excerpt.length > 150 ? "..." : "");

        browser.messageExcerpts.provideExcerpt(msgId, excerpt);
      } catch (e) {
        console.error("Failed to get excerpt:", e);
        browser.messageExcerpts.provideExcerpt(
          msgId,
          "(Failed to load excerpt)",
        );
      }
    });

    // Initialize our experiment
    await browser.messageExcerpts.init();
    console.log("messageExcerpts init finished.");
  } catch (err) {
    console.error("Failed to initialize messageExcerpts API:", err);
  }
}

main();
