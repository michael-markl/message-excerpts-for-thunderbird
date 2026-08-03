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

const ExtensionAPI =
  globalThis.ExtensionAPI ||
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs")
    .ExtensionCommon.ExtensionAPI;
const Services =
  globalThis.Services ||
  ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs")
    .Services;
const ExtensionSupport =
  globalThis.ExtensionSupport ||
  ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs")
    .ExtensionSupport;

// =================================================================
// Global State and Helper Functions
// =================================================================

function logMsg(msg) {
  if (Services && Services.console) {
    Services.console.logStringMessage("CustomColumn: " + msg);
  }
}

/**
 * Recursively searches for the shadow DOM container that holds the message cards.
 * Thunderbird uses a deep Shadow DOM hierarchy, so we must traverse through elements.
 */
function findShadowContainerWithCards(root) {
  if (!root) return null;

  try {
    const cards = Array.from(
      root.querySelectorAll('.card-container, tr[is="thread-card"]'),
    );
    if (cards.length > 0) return { root: root, cards: cards };
  } catch (e) {}

  try {
    const iframes = root.querySelectorAll("iframe, browser");
    for (const frame of iframes) {
      if (frame.contentDocument) {
        const result = findShadowContainerWithCards(frame.contentDocument);
        if (result) return result;
      }
    }
  } catch (e) {}

  try {
    const allElements = root.querySelectorAll("*");
    for (const el of allElements) {
      if (el.shadowRoot) {
        const result = findShadowContainerWithCards(el.shadowRoot);
        if (result) return result;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Injects or updates an excerpt span inside a card element.
 * Handles virtualized row recycling by tracking the msgId stored on the element.
 */
function addExcerptToCard(
  cardElement,
  extension,
  snippetCallbacks,
  extensionState,
) {
  try {
    const rowElement = cardElement.closest("tr") || cardElement;
    let rowIndex = null;

    // Extract the row index from attributes or ID
    if (
      rowElement &&
      rowElement.id &&
      rowElement.id.startsWith("threadTree-row")
    ) {
      rowIndex = rowElement.id.replace("threadTree-row", "");
    } else if (rowElement && rowElement.getAttribute("data-row")) {
      rowIndex = rowElement.getAttribute("data-row");
    } else if (cardElement.getAttribute("data-row")) {
      rowIndex = cardElement.getAttribute("data-row");
    }

    // Retrieve the XPCOM message header
    let msgHdr = null;
    const localWindow = cardElement.ownerDocument
      ? cardElement.ownerDocument.defaultView
      : null;

    if (
      rowIndex !== null &&
      rowElement &&
      rowElement.view &&
      typeof rowElement.view.getMsgHdrAt === "function"
    ) {
      msgHdr = rowElement.view.getMsgHdrAt(parseInt(rowIndex, 10));
    } else if (
      rowIndex !== null &&
      localWindow &&
      localWindow.gFolderDisplay &&
      localWindow.gFolderDisplay.view
    ) {
      msgHdr = localWindow.gFolderDisplay.view.getMsgHdrAt(
        parseInt(rowIndex, 10),
      );
    } else if (rowElement && rowElement.msgHdr) {
      msgHdr = rowElement.msgHdr;
    } else if (cardElement.msgHdr) {
      msgHdr = cardElement.msgHdr;
    }

    if (!msgHdr) return;

    // Convert XPCOM msgHdr to WebExtension msgId
    let msgId = null;
    if (extension && extension.messageManager) {
      try {
        msgId = extension.messageManager.convert(msgHdr).id;
      } catch (e) {}
    }

    // -------------------------------------------------------------
    // Virtualized Row Recycling Handler
    // Check if this row already has the correct excerpt loaded
    // -------------------------------------------------------------
    const existingExcerpt = cardElement.querySelector(".custom-excerpt");
    if (existingExcerpt) {
      if (msgId && String(existingExcerpt.dataset.msgId) === String(msgId)) {
        return; // This row already has the correct excerpt.
      } else {
        existingExcerpt.remove(); // Stale excerpt from a recycled row. Delete it.
      }
    }

    // Create the new excerpt element
    const excerptSpan = cardElement.ownerDocument.createElement("span");
    excerptSpan.className = "custom-excerpt";
    if (msgId) excerptSpan.dataset.msgId = msgId;
    excerptSpan.style.cssText =
      "margin-left: 8px; color: GrayText; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;";
    excerptSpan.textContent = "(Loading excerpt...)";

    // Append to the subject container so it appears natively inline
    const subjectContainer =
      cardElement.querySelector(".thread-card-subject-container") ||
      cardElement.querySelector(".subject").parentNode;
    if (subjectContainer) {
      subjectContainer.appendChild(excerptSpan);
    } else {
      cardElement.appendChild(excerptSpan);
    }

    // -------------------------------------------------------------
    // Asynchronous Fetch Request
    // -------------------------------------------------------------
    if (msgId) {
      // Register callback for when background.js returns the snippet
      snippetCallbacks.set(msgId, (snippet) => {
        // Ensure the row wasn't recycled away while waiting
        if (excerptSpan.parentElement) {
          excerptSpan.textContent = snippet;
        }
      });

      // Emit the request directly. Background.js will handle deduping and caching.
      if (extensionState && extensionState.fireSnippetRequested) {
        extensionState.fireSnippetRequested.async(msgId);
      }
    } else {
      excerptSpan.textContent = "(No WebExt ID)";
    }
  } catch (e) {
    logMsg("Failed to add excerpt to card: " + e);
  }
}

this.customColumn = class customColumn extends ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;

    logMsg("Extension shutting down, forcing cleanup.");
    
    try {
      ExtensionSupport.unregisterWindowListener(this.extension.id);
    } catch (e) {}

    if (this.extension && this.extension.activeStates) {
      for (const state of this.extension.activeStates) {
        if (state.timer) state.win.clearInterval(state.timer);
        if (state.scanner) state.win.clearInterval(state.scanner);
        if (state.observer) state.observer.disconnect();
      }
      this.extension.activeStates.clear();
    }

    const removeAllExcerpts = (rootNode) => {
      if (!rootNode || !rootNode.querySelectorAll) return;
      
      const excerpts = rootNode.querySelectorAll(".custom-excerpt");
      for (let i = 0; i < excerpts.length; i++) {
        excerpts[i].remove();
      }

      const iframes = rootNode.querySelectorAll("iframe, browser");
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentDocument) {
            removeAllExcerpts(iframes[i].contentDocument);
          }
        } catch (e) {} // Cross-origin frames can throw on access
      }

      const allElements = rootNode.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        if (allElements[i].shadowRoot) {
          removeAllExcerpts(allElements[i].shadowRoot);
        }
      }
    };

    const allWindows = Services.wm.getEnumerator("mail:3pane");
    while (allWindows.hasMoreElements()) {
      const win = allWindows.getNext();
      removeAllExcerpts(win.document.documentElement);
    }
  }

  getAPI(context) {
    const extension = context.extension;
    const snippetCallbacks = new Map();
    const extensionState = { fireSnippetRequested: null };

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
            const cb = snippetCallbacks.get(msgId);
            cb(snippet);
            snippetCallbacks.delete(msgId);
          }
        },

        /**
         * Initializes the UI modifications and hooks into Thunderbird's DOM.
         */
        async init() {
          logMsg("init() called in backend!");

          // Use a Set to bypass XrayWrapper identity issues during shutdown
          const activeStates = new Set();
          context.extension.activeStates = activeStates;

          ExtensionSupport.registerWindowListener(extension.id, {
            chromeURLs: [
              "chrome://messenger/content/messenger.xhtml",
              "chrome://messenger/content/messenger.xul",
            ],
            onLoadWindow(win) {
              logMsg("3-pane window loaded, setting up card view.");
              setupCardView(win, activeStates);
            },
            onUnloadWindow(win) {
              logMsg("Unloading extension from window.");
              for (const state of activeStates) {
                // If it's the exact same wrapper, or we just want to clear everything
                if (state.win === win) {
                  if (state.timer) win.clearInterval(state.timer);
                  if (state.scanner) win.clearInterval(state.scanner);
                  if (state.observer) state.observer.disconnect();
                  activeStates.delete(state);
                }
              }
              
              // Remove injected UI
              function removeAllExcerpts(rootNode) {
                if (!rootNode || !rootNode.querySelectorAll) return;

                const excerpts = rootNode.querySelectorAll(".custom-excerpt");
                for (let i = 0; i < excerpts.length; i++) {
                  excerpts[i].remove();
                }

                const iframes = rootNode.querySelectorAll("iframe, browser");
                for (let i = 0; i < iframes.length; i++) {
                  try {
                    if (iframes[i].contentDocument) {
                      removeAllExcerpts(iframes[i].contentDocument);
                    }
                  } catch (e) {} // Cross-origin frames can throw on access
                }

                const allElements = rootNode.querySelectorAll("*");
                for (let i = 0; i < allElements.length; i++) {
                  if (allElements[i].shadowRoot) {
                    removeAllExcerpts(allElements[i].shadowRoot);
                  }
                }
              }
              removeAllExcerpts(win.document.documentElement);
            },
          });

          return Promise.resolve("Backend initialized.");

          /**
           * Sets up the DOM observers and periodic scanners for the provided 3pane window.
           *
           * @param {Window} win the mail 3 pane window
           */
          function setupCardView(win, activeStates) {
            let attempts = 0;
            let setupDone = false;

            const state = { timer: null, scanner: null, observer: null, win: win };
            activeStates.add(state);

            state.timer = win.setInterval(() => {
              if (setupDone) return;
              attempts++;

              const foundData = findShadowContainerWithCards(
                win.document.documentElement,
              );

              if (!foundData) {
                if (attempts > 20) {
                  logMsg(
                    "Gave up waiting for cards to appear after 10 seconds.",
                  );
                  win.clearInterval(state.timer);
                  state.timer = null;
                  return;
                }
                return;
              }

              setupDone = true;
              win.clearInterval(state.timer);
              state.timer = null;
              const container = foundData.root;
              logMsg(
                "Successfully injected into container. Cards found: " +
                  foundData.cards.length,
              );

              // 1. Mutation Observer: Watches for DOM updates to attributes (row recycling) and children (new cards)
              state.observer = new win.MutationObserver((mutations) => {
                const cardsToUpdate = new Set();
                for (const m of mutations) {
                  if (m.type === "childList") {
                    m.addedNodes.forEach((node) => {
                      if (node.nodeType === 1) {
                        if (
                          node.classList &&
                          (node.classList.contains("card-container") ||
                            node.tagName === "TR" ||
                            node.getAttribute("is") === "thread-card")
                        ) {
                          cardsToUpdate.add(node);
                        } else if (node.querySelectorAll) {
                          const cards = node.querySelectorAll(
                            '.card-container, tr[is="thread-card"]',
                          );
                          cards.forEach((c) => cardsToUpdate.add(c));
                        }
                      }
                    });
                  } else if (m.type === "attributes" && m.target) {
                    const node = m.target;
                    if (node.nodeType === 1) {
                      if (
                        node.classList &&
                        (node.classList.contains("card-container") ||
                          node.tagName === "TR" ||
                          node.getAttribute("is") === "thread-card")
                      ) {
                        cardsToUpdate.add(node);
                      } else {
                        const card = node.closest(
                          '.card-container, tr[is="thread-card"]',
                        );
                        if (card) cardsToUpdate.add(card);
                      }
                    }
                  }
                }
                cardsToUpdate.forEach((c) =>
                  addExcerptToCard(
                    c,
                    extension,
                    snippetCallbacks,
                    extensionState,
                  ),
                );
              });
              state.observer.observe(container, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["id", "aria-label", "data-row"],
              });

              // 2. Periodic Scanner: Bulletproof fallback for virtualized list edge cases
              state.scanner = win.setInterval(() => {
                try {
                  const cards = container.querySelectorAll(
                    '.card-container, tr[is="thread-card"]',
                  );
                  cards.forEach((c) =>
                    addExcerptToCard(
                      c,
                      extension,
                      snippetCallbacks,
                      extensionState,
                    ),
                  );
                } catch (e) {}
              }, 500);

              // Initialize existing cards
              for (const card of foundData.cards)
                addExcerptToCard(
                  card,
                  extension,
                  snippetCallbacks,
                  extensionState,
                );
            }, 500);
          }
        },

        /**
         * EventManager that bridges communication to background.js
         */
        onSnippetRequested: new ExtensionCommon.EventManager({
          context,
          name: "customColumn.onSnippetRequested",
          register(fire) {
            logMsg("Snippet request listener registered by background script!");
            extensionState.fireSnippetRequested = fire;
            return () => {
              extensionState.fireSnippetRequested = null;
            };
          },
        }).api(),
      },
    };
  }
};
