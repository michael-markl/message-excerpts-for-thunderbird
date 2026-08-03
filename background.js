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
 * 2. Listening for `onSnippetRequested` events fired from the UI.
 * 3. Fetching the full message content using `browser.messages.getFull`.
 * 4. Parsing the MIME structure to extract plain text.
 * 5. Caching and deduping requests to ensure high performance during scrolling.
 * 6. Returning the processed snippet back to the UI via `provideSnippet`.
 * =====================================================================
 */

/**
 * Extracts plain text from a message part or MIME structure.
 * Automatically parses HTML and cleans up whitespace.
 * Returns the final cleaned text string.
 */
function extractText(part) {
  function findPart(p) {
    if (p.parts && p.parts.length > 0) {
      const plain = p.parts.find((x) => x.contentType === "text/plain");
      if (plain && plain.body) return { text: plain.body, isHtml: false };

      const html = p.parts.find((x) => x.contentType === "text/html");
      if (html && html.body) return { text: html.body, isHtml: true };

      if (p.parts[0]) return findPart(p.parts[0]);
    }

    const isHtmlType =
      p.contentType === "text/html" ||
      (p.headers &&
        p.headers["content-type"] &&
        p.headers["content-type"][0].includes("text/html"));

    if (p.body) return { text: p.body, isHtml: isHtmlType };
    return { text: "", isHtml: false };
  }

  const result = findPart(part);
  let cleanText = result.text;

  if (result.isHtml) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleanText, "text/html");

      // Append spaces to block elements so words don't merge (e.g. <p>Hello</p><p>World</p> -> Hello World)
      const blocks = doc.querySelectorAll(
        "p, div, br, tr, td, h1, h2, h3, h4, h5, h6, li, blockquote",
      );
      blocks.forEach((el) => el.appendChild(doc.createTextNode(" ")));

      // textContent ignores <script> and <style> by default if we just take it from the body,
      // but sometimes they linger. Let's explicitly remove them just in case.
      const scripts = doc.querySelectorAll("script, style, head");
      scripts.forEach((el) => el.remove());

      cleanText = doc.body.textContent || "";
    } catch (e) {
      console.error("DOMParser failed, falling back to basic extraction", e);
    }
  }

  // Cleanup leftover excess whitespace and generic signatures
  return cleanText
    .replace(/\s+/g, " ")
    .replace(/--[\w=-]+/g, "")
    .trim();
}

async function main() {
  console.log("Message Excerpt Card View addon starting...");
  try {
    const memoryCache = new Map();
    const pendingRequests = new Map();

    browser.messageExcerpts.onHeartbeat.addListener(() => {
      // Just receiving this event keeps the Event Page alive. No action needed.
    });

    browser.messageExcerpts.onSnippetRequested.addListener(async (msgId) => {
      try {
        if (memoryCache.has(msgId)) {
          browser.messageExcerpts.provideSnippet(
            msgId,
            memoryCache.get(msgId),
          );
          return;
        }
        if (pendingRequests.has(msgId)) {
          return; // Already actively fetching this snippet
        }
        pendingRequests.set(msgId, true);

        const full = await browser.messages.getFull(msgId);
        const cleanText = extractText(full);
        const snippet =
          cleanText.substring(0, 150) + (cleanText.length > 150 ? "..." : "");

        memoryCache.set(msgId, snippet);
        if (memoryCache.size > 5000) memoryCache.clear(); // Prevent infinite growth

        pendingRequests.delete(msgId);
        browser.messageExcerpts.provideSnippet(msgId, snippet);
      } catch (e) {
        console.error("Failed to get snippet:", e);
        pendingRequests.delete(msgId);
        browser.messageExcerpts.provideSnippet(
          msgId,
          "(Snippet fetch error)",
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
