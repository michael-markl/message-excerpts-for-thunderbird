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
// APIs like `browser.messages.listInlineTextParts()`. However, standard WebExtension APIs
// are NOT available inside an Experiment API script.
//
// Therefore, an architecture bridge is required:
// 1. UI Script (`implementation.js`) injects the loading state, handles caching/deduping,
//    and fires `fireExcerptRequested(msgId)` to signal the background script.
// 2. Background Script (`background.js`) listens for the event, uses the
//    standard `browser.messages.listInlineTextParts()` API to fetch the text,
//    and then sends the excerpt back to the UI via `provideExcerpt()`.
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
// Helpers
// =================================================================

/** From https://stackoverflow.com/a/46432113/3245533, under CC BY-SA 4.0 */
class LRU {
  constructor(max = 10) {
    this.max = max;
    this.cache = new Map();
  }

  has(key) {
    return this.cache.has(key);
  }

  get(key) {
    let item = this.cache.get(key);
    if (item !== undefined) {
      // refresh key
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  set(key, val) {
    // refresh key
    if (this.cache.has(key)) this.cache.delete(key);
    // evict oldest
    else if (this.cache.size === this.max) this.cache.delete(this.first());
    this.cache.set(key, val);
  }

  first() {
    return this.cache.keys().next().value;
  }
}

function logMsg(msg) {
  if (Services && Services.console) {
    Services.console.logStringMessage("messageExcerpts: " + msg);
  }
}

/**
 * Recursively searches for the shadow DOM container that holds the message rows.
 * Thunderbird uses a deep Shadow DOM hierarchy, so we must traverse through elements.
 */
function findShadowContainerWithRows(root) {
  if (!root) return null;

  try {
    const cards = Array.from(
      root.querySelectorAll('tr[is="thread-card"], tr[is="thread-row"]'),
    );
    if (cards.length > 0) return { root: root, cards: cards };
  } catch (e) {}

  try {
    const iframes = root.querySelectorAll("iframe, browser");
    for (const frame of iframes) {
      if (frame.contentDocument) {
        const result = findShadowContainerWithRows(frame.contentDocument);
        if (result) return result;
      }
    }
  } catch (e) {}

  try {
    const allElements = root.querySelectorAll("*");
    for (const el of allElements) {
      if (el.shadowRoot) {
        const result = findShadowContainerWithRows(el.shadowRoot);
        if (result) return result;
      }
    }
  } catch (e) {}

  return null;
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

async function waitForRowsContainer(win) {
  let attempts = 0;
  const NUM_ATTEMPTS = 14;

  while (attempts < NUM_ATTEMPTS) {
    const cardsContainer = findShadowContainerWithRows(
      win.document.documentElement,
    );
    if (cardsContainer) {
      return cardsContainer;
    }
    attempts++;
    if (attempts < NUM_ATTEMPTS) {
      await new Promise((resolve) =>
        win.setTimeout(resolve, Math.pow(2, attempts) * 50),
      );
    }
  }

  logMsg(
    "Could not find cards container after " +
      (Math.pow(2, NUM_ATTEMPTS + 1) - 1) * 50 +
      " ms",
  );
  return null;
}

/**
 * Sets up the DOM observers for the provided 3pane window.
 *
 * @param {Window} win the mail 3 pane window
 */
async function setupMessageView(
  win,
  activeStates,
  extension,
  excerptCallbacks,
  extensionState,
  memoryCache,
) {
  const foundData = await waitForRowsContainer(win);
  const state = { observer: null, timer: null, win: win };
  activeStates.add(state);

  const container = foundData.root;

  // Keep the Event Page alive by firing a dummy request every 10 seconds.
  // This prevents Thunderbird MV3 from suspending the background script,
  // bypassing all the dead-context wakeup bugs!
  state.timer = win.setInterval(() => {
    if (extensionState.fireHeartbeat) {
      try {
        extensionState.fireHeartbeat.async();
      } catch (e) {}
    }
  }, 10000);

  // Mutation Observer: Watches for DOM updates to attributes (row recycling) and children (new cards)
  state.observer = new win.MutationObserver((mutations) => {
    const cardsToUpdate = new Set();
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === win.Node.ELEMENT_NODE) {
            const isAttr = node.getAttribute("is");
            if (isAttr === "thread-card" || isAttr === "thread-row") {
              cardsToUpdate.add(node);
            } else if (node.querySelectorAll) {
              const cards = node.querySelectorAll(
                'tr[is="thread-card"], tr[is="thread-row"]',
              );
              cards.forEach((c) => cardsToUpdate.add(c));
            }
          }
        });
      } else if (m.type === "attributes" && m.target) {
        const node = m.target;
        if (node.nodeType === win.Node.ELEMENT_NODE) {
          const isAttr = node.getAttribute("is");
          if (isAttr === "thread-card" || isAttr === "thread-row") {
            cardsToUpdate.add(node);
          } else {
            const card = node.closest(
              'tr[is="thread-card"], tr[is="thread-row"]',
            );
            if (card) cardsToUpdate.add(card);
          }
        }
      }
    }
    cardsToUpdate.forEach((c) =>
      addExcerptToRow(
        c,
        extension,
        excerptCallbacks,
        extensionState,
        memoryCache,
      ),
    );
  });
  state.observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id", "aria-label", "data-row"],
  });

  // Initialize existing rows
  for (const card of foundData.cards)
    addExcerptToRow(
      card,
      extension,
      excerptCallbacks,
      extensionState,
      memoryCache,
    );
}

/**
 * Injects or updates an excerpt span inside a row element.
 * Handles virtualized row recycling by tracking the msgId stored on the element.
 */
function addExcerptToRow(
  rowElement,
  extension,
  excerptCallbacks,
  extensionState,
  memoryCache,
) {
  const isAttr = rowElement.getAttribute("is");
  if (isAttr !== "thread-card" && isAttr !== "thread-row") {
    logMsg("Not a thread row/card. Outer HTML:" + rowElement.outerHTML);
    return;
  }
  try {
    // Extract the row index from ID
    if (!rowElement.id || !rowElement.id.startsWith("threadTree-row")) {
      return;
    }
    const rowIndex = parseInt(rowElement.id.replace("threadTree-row", ""), 10);
    const msgHdr = rowElement.view.getMsgHdrAt(rowIndex);
    if (!msgHdr) {
      logMsg("No message header found for row: #" + rowElement.id);
      return;
    }

    // Convert XPCOM msgHdr to WebExtension msgId
    let msgId;
    try {
      msgId = extension.messageManager.convert(msgHdr).id;
    } catch (e) {
      logMsg("Failed to convert msgHdr to msgId: " + e);
      return;
    }

    // -------------------------------------------------------------
    // Virtualized Row Recycling Handler
    // Check if this row already has the correct excerpt loaded
    // -------------------------------------------------------------
    const existingExcerpt = rowElement.querySelector(".custom-excerpt");
    if (existingExcerpt) {
      if (existingExcerpt.dataset.msgId === String(msgId)) {
        return; // This row already has the correct excerpt.
      }
      existingExcerpt.remove(); // Stale excerpt from a recycled row. Delete it.
    }

    // Create the new excerpt element
    const excerptSpan = rowElement.ownerDocument.createElement("span");
    excerptSpan.className = "custom-excerpt";
    if (msgId) excerptSpan.dataset.msgId = msgId;
    excerptSpan.style.cssText =
      "margin-left: 8px; color: GrayText; font-size: 0.9em; text-overflow: ellipsis;";
    excerptSpan.textContent = "(Loading excerpt...)";

    // Append to the subject container so it appears natively inline
    let subjectContainer;
    if (isAttr === "thread-card") {
      subjectContainer = rowElement.querySelector(
        ".thread-card-subject-container",
      );
    } else if (isAttr === "thread-row") {
      subjectContainer = rowElement.querySelector(".subject-line");
    }

    if (!subjectContainer) {
      logMsg("No subject container found for row: " + rowElement.outerHTML);
      return;
    }
    subjectContainer.appendChild(excerptSpan);

    const applyExcerpt = (payload) => {
      // Ensure the row wasn't recycled away while waiting
      if (excerptSpan.parentElement) {
        if (payload.status === "success") {
          excerptSpan.textContent = payload.excerpt;
        } else {
          excerptSpan.textContent = "(Failed to load excerpt.)";
        }
      }
    };

    if (memoryCache.has(msgId)) {
      applyExcerpt({ status: "success", excerpt: memoryCache.get(msgId) });
      return;
    }

    if (excerptCallbacks.has(msgId)) {
      excerptCallbacks.get(msgId).push(applyExcerpt);
      return; // Already actively fetching this excerpt
    } else {
      excerptCallbacks.set(msgId, [applyExcerpt]);
    }

    // Emit the request. Background.js will handle fetching.
    if (extensionState.fireExcerptRequested) {
      try {
        extensionState.fireExcerptRequested.async(msgId);
      } catch (e) {
        // If the fire object was invalidated by the framework,
        // we'll catch the error and queue it instead.
        queueRequest(msgId);
      }
    } else {
      queueRequest(msgId);
    }

    function queueRequest(id) {
      extensionState.pendingRequests.add(id);
      logMsg(
        "Queued excerpt request for " +
          id +
          " because background script is not yet attached.",
      );
    }
  } catch (e) {
    logMsg("Failed to add excerpt to card: " + e);
  }
}

this.messageExcerpts = class messageExcerpts extends ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;

    logMsg("Extension shutting down, forcing cleanup.");

    try {
      ExtensionSupport.unregisterWindowListener(this.extension.id);
    } catch (e) {}

    if (this.extension && this.extension.activeStates) {
      for (const state of this.extension.activeStates) {
        if (state.timer) state.win.clearInterval(state.timer);
        if (state.observer) state.observer.disconnect();
        removeAllExcerpts(state.win.document.documentElement);
      }
      this.extension.activeStates.clear();
    }
  }

  getAPI(context) {
    const extension = context.extension;

    const activeStates = new Set();
    context.extension.activeStates = activeStates;

    const memoryCache = new LRU(5000);
    const excerptCallbacks = new Map();
    const extensionState = {
      fireExcerptRequested: null,
      fireHeartbeat: null,
      pendingRequests: new Set(),
    };

    return {
      messageExcerpts: {
        /**
         * Called by background.js to provide the excerpt back to the UI.
         */
        provideExcerpt(msgId, payload) {
          if (payload.status === "success") {
            memoryCache.set(msgId, payload.excerpt);
          }

          if (excerptCallbacks.has(msgId)) {
            const callbacks = excerptCallbacks.get(msgId);
            callbacks.forEach((cb) => cb(payload));
            excerptCallbacks.delete(msgId);
          }
        },

        /**
         * Initializes the UI modifications and hooks into Thunderbird's DOM.
         */
        async init() {
          logMsg("init() called in backend!");

          ExtensionSupport.registerWindowListener(extension.id, {
            chromeURLs: [
              "chrome://messenger/content/messenger.xhtml",
              "chrome://messenger/content/messenger.xul",
            ],
            onLoadWindow(win) {
              logMsg("3-pane window loaded, setting up view.");
              setupMessageView(
                win,
                activeStates,
                extension,
                excerptCallbacks,
                extensionState,
                memoryCache,
              );
            },
            onUnloadWindow(win) {
              logMsg("Unloading extension from window.");
              for (const state of activeStates) {
                // If it's the exact same wrapper, or we just want to clear everything
                if (state.win === win) {
                  if (state.timer) win.clearInterval(state.timer);
                  if (state.observer) state.observer.disconnect();
                  activeStates.delete(state);
                }
              }

              removeAllExcerpts(win.document.documentElement);
            },
          });

          return Promise.resolve("Backend initialized.");
        },

        /**
         * EventManager that bridges communication to background.js
         */
        onExcerptRequested: new ExtensionCommon.EventManager({
          context,
          name: "messageExcerpts.onExcerptRequested",
          register(fire) {
            logMsg("Excerpt request listener registered by background script!");
            extensionState.fireExcerptRequested = fire;

            // Flush any requests that came in before registration
            for (const msgId of extensionState.pendingRequests) {
              fire.async(msgId);
            }
            extensionState.pendingRequests.clear();

            return () => {
              logMsg(
                "Excerpt request listener cleanup called (Event Page suspended).",
              );
              extensionState.fireExcerptRequested = null;
            };
          },
        }).api(),

        onHeartbeat: new ExtensionCommon.EventManager({
          context,
          name: "messageExcerpts.onHeartbeat",
          register(fire) {
            extensionState.fireHeartbeat = fire;
            return () => {
              extensionState.fireHeartbeat = null;
            };
          },
        }).api(),
      },
    };
  }
};
