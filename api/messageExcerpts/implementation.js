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

const ExtensionCommon =
  globalThis.ExtensionCommon ||
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs")
    .ExtensionCommon;

const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

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

class DeferredPromise extends Promise {
  constructor() {
    let myResolve, myReject;
    super((resolve, reject) => {
      myResolve = resolve;
      myReject = reject;
    });
    this.resolve = myResolve;
    this.reject = myReject;
  }

  static get [Symbol.species]() {
    return Promise;
  }
}

class TimeoutError extends Error {}

// Limits waiting, without canceling the underlying operation.
function timeout(ms, promise) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`Request timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const ROW_SELECTOR = 'tr[is="thread-card"], tr[is="thread-row"]';

function installExcerptStyles(container) {
  if (container.querySelector(".custom-excerpt-styles")) return;
  const document = container.ownerDocument || container;
  const style = document.createElement("style");
  style.className = "custom-excerpt-styles";
  style.textContent = `
    #threadTree:not(.cards-row-compact) .thread-card-dynamic-row.custom-excerpt-third-row {
      grid-template: "subject subject subject" max-content
                     "button excerpt info" minmax(auto, 1fr) / auto minmax(0, 1fr) auto !important;
    }
    .custom-excerpt {
      margin-inline-start: 8px;
      color: GrayText;
      font-size: 0.9em;
      text-overflow: ellipsis;
    }
    .custom-excerpt-third-row > .custom-excerpt {
      grid-area: excerpt;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      margin-inline-start: 0;
    }
  `;
  (container.head || container).appendChild(style);
}

function placeExcerpt(rowElement, excerptSpan, extensionState) {
  const isCard = rowElement.getAttribute("is") === "thread-card";
  const subject = rowElement.querySelector(
    isCard ? ".thread-card-subject-container" : ".subject-line",
  );
  const dynamicRow = isCard
    ? rowElement.querySelector(".thread-card-dynamic-row")
    : null;
  const tree = rowElement.closest("#threadTree");
  const useThirdRow = !!(
    extensionState.excerptInThirdRow &&
    dynamicRow &&
    tree &&
    !tree.classList.contains("cards-row-compact")
  );
  if (dynamicRow) {
    dynamicRow.classList.toggle("custom-excerpt-third-row", useThirdRow);
  }
  const target = useThirdRow ? dynamicRow : subject;
  if (!target) return;
  if (excerptSpan.parentElement !== target) target.appendChild(excerptSpan);
}

/**
 * Recursively searches for the shadow DOM container that holds the message rows.
 * Thunderbird uses a deep Shadow DOM hierarchy, so we must traverse through elements.
 */
function findShadowContainerWithRows(root) {
  if (!root) return null;

  try {
    const cards = Array.from(root.querySelectorAll(ROW_SELECTOR));
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
  for (const style of rootNode.querySelectorAll(".custom-excerpt-styles")) {
    style.remove();
  }
  for (const row of rootNode.querySelectorAll(".custom-excerpt-third-row")) {
    row.classList.remove("custom-excerpt-third-row");
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
  if (!foundData || win.closed || extensionState.stopped) return;
  const state = { observer: null, win };
  activeStates.add(state);

  const container = foundData.root;
  installExcerptStyles(container);
  state.refresh = () => {
    for (const row of container.querySelectorAll(ROW_SELECTOR)) {
      addExcerptToRow(
        row,
        extension,
        excerptCallbacks,
        extensionState,
        memoryCache,
      );
    }
  };

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
              const cards = node.querySelectorAll(ROW_SELECTOR);
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
            const card = node.closest(ROW_SELECTOR);
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
    attributeFilter: ["id", "aria-label", "data-row", "data-properties"],
  });
  state.refresh();
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
  if (rowElement.dataset.properties?.split(/\s+/).includes("dummy")) {
    rowElement.querySelector(".custom-excerpt")?.remove();
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
      if (
        existingExcerpt.dataset.msgId === String(msgId) &&
        existingExcerpt.dataset.status !== "failed"
      ) {
        placeExcerpt(rowElement, existingExcerpt, extensionState);
        // This row already has the correct excerpt.
        return;
      }
      // Stale excerpt from a recycled row. Delete it.
      existingExcerpt.remove();
    }

    // Create the new excerpt element
    const excerptSpan = rowElement.ownerDocument.createElement("span");
    excerptSpan.className = "custom-excerpt";
    if (msgId) excerptSpan.dataset.msgId = msgId;
    excerptSpan.dataset.status = "loading";
    excerptSpan.textContent = "(Loading excerpt...)";

    placeExcerpt(rowElement, excerptSpan, extensionState);
    if (!excerptSpan.parentElement) {
      logMsg("No subject container found for row: " + rowElement.outerHTML);
      return;
    }

    const applyExcerpt = (payload) => {
      // Ensure the row wasn't recycled away while waiting
      if (excerptSpan.parentElement) {
        excerptSpan.dataset.status = payload.status;
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
      // Already actively fetching this excerpt
      excerptCallbacks.get(msgId).push(applyExcerpt);
      return;
    } else {
      excerptCallbacks.set(msgId, [applyExcerpt]);
    }

    // The Experiment owns requests across background page lifetimes.
    extensionState.requestExcerpt(msgId);
  } catch (e) {
    logMsg("Failed to add excerpt to card: " + e);
  }
}

this.messageExcerpts = class extends ExtensionCommon.ExtensionAPIPersistent {
  // These fields belong to the Experiment instance, not a background context.
  activeStates = new Set();
  pendingWindows = new Set();
  memoryCache = new LRU(5000);
  excerptCallbacks = new Map();
  requests = new Map();
  // Pending background replies, shared across background contexts.
  bgRequests = new Map();
  nextAttemptId = 0;
  initialized = false;
  excerptFetcher = null;
  extensionState = {
    stopped: false,
    excerptInThirdRow: true,
    requestExcerpt: (msgId) => this.requestExcerpt(msgId),
  };

  PERSISTENT_EVENTS = {
    onExcerptRequested: ({ fire }) => {
      const binding = { fire };
      this.excerptFetcher = binding;
      // Defer delivery until listener registration has completed.
      Promise.resolve().then(() => this.flushBgRequests());
      return {
        unregister: () => {
          if (this.excerptFetcher !== binding) return;
          this.excerptFetcher = null;
          // Lost contexts use the same bounded retry policy as other failures.
          for (const attempt of this.bgRequests.values()) {
            attempt.deferred.reject(
              new Error("Binding Fetcher was unregistered."),
            );
          }
        },
        convert: (newFire) => {
          binding.fire = newFire;
        },
      };
    },
  };

  async requestExcerpt(msgId) {
    if (this.extensionState.stopped || this.requests.has(msgId)) return;
    const request = {
      msgId,
      backoffBase: 100 + Math.random() * 100,
    };
    this.requests.set(msgId, request);
    try {
      const excerpt = await this.runRequest(request);
      this.memoryCache.set(msgId, excerpt);
      this.broadcastPayload(msgId, { status: "success", excerpt });
    } catch (error) {
      logMsg("Excerpt request failed: " + error);
      this.broadcastPayload(msgId, { status: "failed" });
    } finally {
      this.requests.delete(msgId);
    }
  }

  async runRequest(request) {
    let errors = [];
    const maxAttempts = 5;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      try {
        return await this.runAttempt(request);
      } catch (error) {
        errors.push(error);
        if (attemptNumber < maxAttempts) {
          await delay(request.backoffBase * 2 ** (attemptNumber - 1));
        }
      }
    }
    throw new AggregateError(
      errors,
      `Could not retrieve excerpt after ${maxAttempts} attempts.`,
    );
  }

  async runAttempt(request) {
    const deferred = new DeferredPromise();
    const attempt = {
      id: ++this.nextAttemptId,
      dispatched: false,
      msgId: request.msgId,
      deferred,
    };
    this.bgRequests.set(attempt.id, attempt);
    // dispatch errors are not caught, as we allow dispatches to be deferred.
    this.dispatchBgRequest(attempt);
    return await timeout(30000, deferred).finally(() =>
      this.bgRequests.delete(attempt.id),
    );
  }

  flushBgRequests() {
    for (const attempt of this.bgRequests.values()) {
      this.dispatchBgRequest(attempt);
    }
  }

  async dispatchBgRequest(attempt) {
    const binding = this.excerptFetcher;
    if (!binding || !attempt || attempt.dispatched) return;
    attempt.dispatched = true;
    // A primed event wakes the background. convert() supplies its live fire.
    if (binding.fire.wakeup) await binding.fire.wakeup();
    if (this.excerptFetcher !== binding) return;
    await binding.fire.async(attempt.msgId, attempt.id);
  }

  broadcastPayload(msgId, payload) {
    const callbacks = this.excerptCallbacks.get(msgId) || [];
    this.excerptCallbacks.delete(msgId);
    for (const callback of callbacks) {
      try {
        callback(payload);
      } catch (error) {
        logMsg("Could not update excerpt row: " + error);
      }
    }
  }

  setupWindow(win) {
    if (
      this.extensionState.stopped ||
      this.pendingWindows.has(win) ||
      [...this.activeStates].some((state) => state.win === win)
    )
      return;
    this.pendingWindows.add(win);
    setupMessageView(
      win,
      this.activeStates,
      this.extension,
      this.excerptCallbacks,
      this.extensionState,
      this.memoryCache,
    )
      .catch((error) => logMsg("Could not set up message view: " + error))
      .finally(() => this.pendingWindows.delete(win));
  }

  init() {
    if (this.initialized || this.extensionState.stopped) return;
    ExtensionSupport.registerWindowListener(this.extension.id, {
      chromeURLs: [
        "chrome://messenger/content/messenger.xhtml",
        "chrome://messenger/content/messenger.xul",
      ],
      onLoadWindow: (win) => this.setupWindow(win),
      onUnloadWindow: (win) => {
        for (const state of this.activeStates) {
          if (state.win === win) {
            state.observer?.disconnect();
            this.activeStates.delete(state);
          }
        }
        removeAllExcerpts(win.document.documentElement);
      },
    });
    this.initialized = true;
  }

  onShutdown(isAppShutdown) {
    this.extensionState.stopped = true;
    this.requests.clear();
    this.bgRequests.clear();
    this.excerptCallbacks.clear();
    this.excerptFetcher = null;
    if (isAppShutdown) return;
    if (this.initialized) {
      ExtensionSupport.unregisterWindowListener(this.extension.id);
    }
    for (const state of this.activeStates) {
      state.observer?.disconnect();
      removeAllExcerpts(state.win.document.documentElement);
    }
    this.activeStates.clear();
    this.pendingWindows.clear();
    Services.obs.notifyObservers(null, "startupcache-invalidate", null);
  }

  getAPI(context) {
    return {
      messageExcerpts: {
        setExcerptInThirdRow: (enabled) => {
          this.extensionState.excerptInThirdRow = enabled;
          for (const state of this.activeStates) state.refresh();
        },
        provideExcerpt: (bgRequestId, payload) => {
          const bgRequest = this.bgRequests.get(bgRequestId);
          if (!bgRequest) return;
          if (
            payload.status === "success" &&
            typeof payload.excerpt === "string"
          ) {
            bgRequest.deferred.resolve(payload.excerpt);
          } else {
            bgRequest.deferred.reject(new Error("Background request failed"));
          }
        },
        init: () => this.init(),
        onExcerptRequested: new ExtensionCommon.EventManager({
          context,
          module: "messageExcerpts",
          event: "onExcerptRequested",
          extensionApi: this,
        }).api(),
      },
    };
  }
};
