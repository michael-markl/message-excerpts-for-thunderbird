// =====================================================================
// Thunderbird Subject Excerpt Column (Experiment API)
// =====================================================================
//
// WHY BACKGROUND.JS IS NECESSARY:
// --------------------------------
// This Experiment API (`implementation.js`) has privileged access to the
// Thunderbird DOM (to inject UI elements) and XPCOM objects (like `msgHdr`),
// but reading a full message body is complex (requires MIME parsing, handling
// IMAP vs POP3, etc).
//
// The official, standard way to get message contents is via the WebExtension
// API: `browser.messages.getFull()`. However, standard WebExtension APIs
// are NOT available inside an Experiment API script.
//
// Therefore, an architecture bridge is required:
// 1. UI Script (`implementation.js`) injects the loading state and fires
//    `fireSnippetRequested(msgId)` to signal the background script.
// 2. Background Script (`background.js`) listens for the event, uses the
//    standard `browser.messages.getFull()` API to fetch and parse the email,
//    and then sends the snippet back to the UI via `provideSnippet()`.
// =====================================================================

var myExtensionAPI = globalThis.ExtensionAPI || ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm").ExtensionCommon.ExtensionAPI;
var myServices = globalThis.Services || ChromeUtils.import("resource://gre/modules/Services.jsm").Services;

var customColumn = class extends myExtensionAPI {
  getAPI(context) {
    let extension = context.extension;
    
    // Map to hold callbacks so we know where to place the snippet once fetched
    // Keeping it inside the getAPI closure is much safer than attaching to DOM windows
    let snippetCallbacks = new Map();
    
    // Reference to the EventManager fire function for sending messages to background.js
    let fireSnippetRequested = null;
    
    function logMsg(msg) {
      if (myServices && myServices.console) {
        myServices.console.logStringMessage("CustomColumn: " + msg);
      }
    }

    // =================================================================
    // Helper Functions
    // =================================================================

    /**
     * Recursively searches for the shadow DOM container that holds the message cards.
     * Thunderbird uses a deep Shadow DOM hierarchy, so we must traverse through elements.
     */
    function findShadowContainerWithCards(root) {
      if (!root) return null;
      
      try {
         let cards = Array.from(root.querySelectorAll('.card-container, tr[is="thread-card"]'));
         if (cards.length > 0) return { root: root, cards: cards };
      } catch(e) {}
      
      try {
         let iframes = root.querySelectorAll('iframe, browser');
         for (let frame of iframes) {
           if (frame.contentDocument) {
              let result = findShadowContainerWithCards(frame.contentDocument);
              if (result) return result;
           }
         }
      } catch(e) {}
      
      try {
         let allElements = root.querySelectorAll('*');
         for (let el of allElements) {
           if (el.shadowRoot) {
             let result = findShadowContainerWithCards(el.shadowRoot);
             if (result) return result;
           }
         }
      } catch(e) {}
      
      return null;
    }

    /**
     * Injects or updates an excerpt span inside a card element.
     * Handles virtualized row recycling by tracking the msgId stored on the element.
     */
    function addExcerptToCard(cardElement) {
      try {
         let rowElement = cardElement.closest("tr") || cardElement;
         let rowIndex = null;
         
         // Extract the row index from attributes or ID
         if (rowElement && rowElement.id && rowElement.id.startsWith("threadTree-row")) {
             rowIndex = rowElement.id.replace("threadTree-row", "");
         } else if (rowElement && rowElement.getAttribute("data-row")) {
             rowIndex = rowElement.getAttribute("data-row");
         } else if (cardElement.getAttribute("data-row")) {
             rowIndex = cardElement.getAttribute("data-row");
         }
         
         // Retrieve the XPCOM message header
         let msgHdr = null;
         let localWindow = cardElement.ownerDocument ? cardElement.ownerDocument.defaultView : null;
         
         if (rowIndex !== null && rowElement && rowElement.view && typeof rowElement.view.getMsgHdrAt === "function") {
           msgHdr = rowElement.view.getMsgHdrAt(parseInt(rowIndex, 10));
         } else if (rowIndex !== null && localWindow && localWindow.gFolderDisplay && localWindow.gFolderDisplay.view) {
           msgHdr = localWindow.gFolderDisplay.view.getMsgHdrAt(parseInt(rowIndex, 10));
         } else if (rowElement && rowElement.msgHdr) {
           msgHdr = rowElement.msgHdr;
         } else if (cardElement.msgHdr) {
           msgHdr = cardElement.msgHdr;
         }
         
         if (!msgHdr) return;

         // Convert XPCOM msgHdr to WebExtension msgId
         let msgId = null;
         if (extension.messageManager) {
             try { msgId = extension.messageManager.convert(msgHdr).id; } catch(e){}
         }
         
         // -------------------------------------------------------------
         // Virtualized Row Recycling Handler
         // Check if this row already has the correct excerpt loaded
         // -------------------------------------------------------------
         let existingExcerpt = cardElement.querySelector('.custom-excerpt');
         if (existingExcerpt) {
             if (msgId && String(existingExcerpt.dataset.msgId) === String(msgId)) {
                 return; // This row already has the correct excerpt.
             } else {
                 existingExcerpt.remove(); // Stale excerpt from a recycled row. Delete it.
             }
         }
         
         // Create the new excerpt element
         let excerptDiv = cardElement.ownerDocument.createElement("span");
         excerptDiv.className = "custom-excerpt";
         if (msgId) excerptDiv.dataset.msgId = msgId;
         excerptDiv.style.cssText = "display: inline-block; flex: 1; margin-left: 8px; color: GrayText; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;";
         excerptDiv.textContent = "(Loading excerpt...)";
         
         // Append to the subject container so it appears natively inline
         let subjectContainer = cardElement.querySelector('.thread-card-subject-container') || cardElement.querySelector('.subject').parentNode;
         if (subjectContainer) {
             subjectContainer.appendChild(excerptDiv);
         } else {
             cardElement.appendChild(excerptDiv);
         }
         
         // -------------------------------------------------------------
         // Asynchronous Fetch Request
         // -------------------------------------------------------------
         if (msgId) {
             // Register callback for when background.js returns the snippet
             snippetCallbacks.set(msgId, (snippet) => {
                 // Ensure the row wasn't recycled away while waiting
                 if (excerptDiv.parentElement) {
                     excerptDiv.textContent = snippet;
                 }
             });
             
             // Emit the request directly. Background.js will handle deduping and caching.
             if (fireSnippetRequested) {
                 fireSnippetRequested.async(msgId);
             }
         } else {
             excerptDiv.textContent = "(No WebExt ID)";
         }
      } catch (e) {
         logMsg("Failed to add excerpt to card: " + e);
      }
    }

    // =================================================================
    // API Export
    // =================================================================
    return {
      customColumn: {
        /**
         * Called by background.js to provide the snippet back to the UI.
         */
        async provideSnippet(msgId, snippet) {
            if (snippetCallbacks.has(msgId)) {
                let cb = snippetCallbacks.get(msgId);
                cb(snippet);
                snippetCallbacks.delete(msgId);
            }
        },

        /**
         * Initializes the UI modifications and hooks into Thunderbird's DOM.
         */
        async init() {
          return new Promise((resolve) => {
            logMsg("init() called in backend!");
            
            // Wait for 3pane window to load
            let windowListener = {
              onOpenWindow(xulWindow) {
                let win = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
                win.addEventListener("load", function listener() {
                  win.removeEventListener("load", listener, false);
                  if (win.document.documentElement.getAttribute("windowtype") === "mail:3pane") {
                    setupCardView(win);
                  }
                }, false);
              },
              onCloseWindow() {},
              onWindowTitleChange() {}
            };
            
            myServices.wm.addListener(windowListener);
            
            // Check existing windows
            let allWindows = myServices.wm.getEnumerator("mail:3pane");
            let found3Pane = false;
            while (allWindows.hasMoreElements()) {
              let win = allWindows.getNext();
              if (win.document.documentElement.getAttribute("windowtype") === "mail:3pane") {
                found3Pane = true;
                setupCardView(win);
              }
            }
            
            if (!found3Pane) logMsg("WARNING: No mail:3pane window was found during init.");
            resolve("Backend initialized.");
            
            /**
             * Sets up the DOM observers and periodic scanners for the provided 3pane window.
             */
            function setupCardView(win) {
              let attempts = 0;
              let setupDone = false;
              
              function attemptSetup() {
                if (setupDone) return;
                attempts++;
                
                let foundData = findShadowContainerWithCards(win.document.documentElement);
                
                if (!foundData) {
                  if (attempts > 20) {
                     logMsg("Gave up waiting for cards to appear after 10 seconds.");
                     return;
                  }
                  win.setTimeout(attemptSetup, 500);
                  return;
                }
                
                setupDone = true;
                let container = foundData.root;
                logMsg("Successfully injected into container. Cards found: " + foundData.cards.length);

                // 1. Mutation Observer: Watches for DOM updates to attributes (row recycling) and children (new cards)
                let observer = new win.MutationObserver((mutations) => {
                 let cardsToUpdate = new Set();
                 for (let m of mutations) {
                     if (m.type === 'childList') {
                         m.addedNodes.forEach(node => {
                             if (node.nodeType === 1) {
                                 if (node.classList && (node.classList.contains("card-container") || node.tagName === "TR" || node.getAttribute("is") === "thread-card")) {
                                     cardsToUpdate.add(node);
                                 } else if (node.querySelectorAll) {
                                     let cards = node.querySelectorAll('.card-container, tr[is="thread-card"]');
                                     cards.forEach(c => cardsToUpdate.add(c));
                                 }
                             }
                         });
                     } else if (m.type === 'attributes' && m.target) {
                         let node = m.target;
                         if (node.nodeType === 1) {
                             if (node.classList && (node.classList.contains("card-container") || node.tagName === "TR" || node.getAttribute("is") === "thread-card")) {
                                 cardsToUpdate.add(node);
                             } else {
                                 let card = node.closest('.card-container, tr[is="thread-card"]');
                                 if (card) cardsToUpdate.add(card);
                             }
                         }
                     }
                 }
                 cardsToUpdate.forEach(c => addExcerptToCard(c));
                });
                observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "aria-label", "data-row"] });
                
                // 2. Periodic Scanner: Bulletproof fallback for virtualized list edge cases
                win.setInterval(() => {
                   try {
                       let cards = container.querySelectorAll('.card-container, tr[is="thread-card"]');
                       cards.forEach(c => addExcerptToCard(c));
                   } catch(e){}
                }, 500);
                
                // Initialize existing cards
                for (let card of foundData.cards) addExcerptToCard(card);
              }
              
              attemptSetup();
            }
          });
        },
        
        /**
         * EventManager that bridges communication to background.js
         */
        onSnippetRequested: new ExtensionCommon.EventManager({
          context,
          name: "customColumn.onSnippetRequested",
          register(fire) {
            logMsg("Snippet request listener registered by background script!");
            fireSnippetRequested = fire;
            return () => {
              fireSnippetRequested = null;
            };
          }
        }).api()
      }
    };
  }
};
