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

/**
 * Extracts plain text from a message part or MIME structure.
 * Automatically parses HTML and cleans up whitespace.
 * Returns the final cleaned text string.
 */
function extractText(part) {
    function findPart(p) {
        if (p.parts && p.parts.length > 0) {
            let plain = p.parts.find(x => x.contentType === "text/plain");
            if (plain && plain.body) return { text: plain.body, isHtml: false };
            
            let html = p.parts.find(x => x.contentType === "text/html");
            if (html && html.body) return { text: html.body, isHtml: true };
            
            if (p.parts[0]) return findPart(p.parts[0]);
        }
        
        let isHtmlType = p.contentType === "text/html" || 
                         (p.headers && p.headers['content-type'] && p.headers['content-type'][0].includes('text/html'));
                         
        if (p.body) return { text: p.body, isHtml: isHtmlType };
        return { text: "", isHtml: false };
    }
    
    let result = findPart(part);
    let cleanText = result.text;
    
    if (result.isHtml) {
        try {
            let parser = new DOMParser();
            let doc = parser.parseFromString(cleanText, "text/html");
            
            // Append spaces to block elements so words don't merge (e.g. <p>Hello</p><p>World</p> -> Hello World)
            let blocks = doc.querySelectorAll('p, div, br, tr, td, h1, h2, h3, h4, h5, h6, li, blockquote');
            blocks.forEach(el => el.appendChild(doc.createTextNode(' ')));
            
            // textContent ignores <script> and <style> by default if we just take it from the body,
            // but sometimes they linger. Let's explicitly remove them just in case.
            let scripts = doc.querySelectorAll('script, style, head');
            scripts.forEach(el => el.remove());
            
            cleanText = doc.body.textContent || "";
        } catch(e) {
            console.error("DOMParser failed, falling back to basic extraction", e);
        }
    }
    
    // Cleanup leftover excess whitespace and generic signatures
    return cleanText.replace(/\s+/g, ' ').replace(/--[\w=-]+/g, '').trim();
}

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
            let cleanText = extractText(full);
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
