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
 * 1. Initializing the Custom Column Experiment API.
 * 2. Listening for `onSnippetRequested` events fired from the UI.
 * 3. Fetching the full message content using `browser.messages.getFull`.
 * 4. Parsing the MIME structure to extract plain text.
 * 5. Caching and deduping requests to ensure high performance during scrolling.
 * 6. Returning the processed snippet back to the UI via `provideSnippet`.
 * =====================================================================
 */

async function main() {
  console.log("Message Excerpt Card View addon starting...");
  try {
    let memoryCache = new Map();
    let pendingRequests = new Map();

    browser.customColumn.onSnippetRequested.addListener(async (msgId) => {
        try {
            if (memoryCache.has(msgId)) {
                await browser.customColumn.provideSnippet(msgId, memoryCache.get(msgId));
                return;
            }
            if (pendingRequests.has(msgId)) {
                return; // Already actively fetching this snippet
            }
            pendingRequests.set(msgId, true);

            let full = await browser.messages.getFull(msgId);
            
            let extractText = (part) => {
                if (part.body) return part.body;
                if (part.parts) {
                    let plain = part.parts.find(p => p.contentType === "text/plain");
                    if (plain && plain.body) return plain.body;
                    let html = part.parts.find(p => p.contentType === "text/html");
                    if (html && html.body) return html.body;
                    if (part.parts[0]) return extractText(part.parts[0]);
                }
                return "";
            };
            
            let text = "";
            if (full.parts && full.parts.length > 0) {
                let plain = full.parts.find(p => p.contentType === "text/plain");
                if (plain && plain.body) text = plain.body;
                else text = extractText(full);
            } else if (full.body) {
                text = full.body;
            }
            
            // Strip HTML and whitespace
            text = text.replace(/<head[^>]*>.*?<\/head>/gi, '')
                       .replace(/<style[^>]*>.*?<\/style>/gi, '')
                       .replace(/<script[^>]*>.*?<\/script>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ')
                       .replace(/\s+/g, ' ')
                       .trim();
                       
            let cleanText = text.replace(/--[\w=-]+/g, '').trim();
            let snippet = cleanText.substring(0, 150) + (cleanText.length > 150 ? "..." : "");
            
            memoryCache.set(msgId, snippet);
            if (memoryCache.size > 5000) memoryCache.clear(); // Prevent infinite growth
            
            pendingRequests.delete(msgId);
            await browser.customColumn.provideSnippet(msgId, snippet);
        } catch (e) {
            console.error("Failed to get snippet:", e);
            pendingRequests.delete(msgId);
            await browser.customColumn.provideSnippet(msgId, "(Snippet fetch error)");
        }
    });

    // Initialize our experiment
    let result = await browser.customColumn.init().then((msg) => {
      console.log("customColumn init finished:", msg);
    }).catch((err) => {
      console.error("customColumn init failed:", err);
    });
  } catch (err) {
    console.error("Failed to initialize customColumn API:", err);
  }
}

main();
