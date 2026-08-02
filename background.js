async function main() {
  console.log("Message Excerpt Card View addon starting...");
  try {
    let memoryCache = new Map();

    browser.customColumn.onSnippetRequested.addListener(async (msgId) => {
        try {
            if (memoryCache.has(msgId)) {
                await browser.customColumn.provideSnippet(msgId, memoryCache.get(msgId));
                return;
            }

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
            text = text.replace(/<style[^>]*>.*?<\/style>/gi, '')
                       .replace(/<script[^>]*>.*?<\/script>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ')
                       .replace(/\s+/g, ' ')
                       .trim();
                       
            let cleanText = text.replace(/--[\w=-]+/g, '').trim();
            let snippet = cleanText.substring(0, 150) + (cleanText.length > 150 ? "..." : "");
            
            memoryCache.set(msgId, snippet);
            if (memoryCache.size > 5000) memoryCache.clear(); // Prevent infinite growth
            
            await browser.customColumn.provideSnippet(msgId, snippet);
        } catch (e) {
            console.error("Failed to get snippet:", e);
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
