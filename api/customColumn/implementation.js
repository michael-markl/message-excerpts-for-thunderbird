var myExtensionAPI = globalThis.ExtensionAPI;
if (!myExtensionAPI) {
  myExtensionAPI = ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm").ExtensionCommon.ExtensionAPI;
}

var myServices = globalThis.Services;
if (!myServices) {
  myServices = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
}

var customColumn = class extends myExtensionAPI {
  getAPI(context) {
    let extension = context.extension;
    
    // Global map to hold callbacks for snippets
    let window = Services.wm.getMostRecentWindow("mail:3pane");
    if (window && !window._snippetCallbacks) {
        window._snippetCallbacks = new Map();
    }
    
    let fireSnippetRequested = null;
    
    function logMsg(msg) {
      if (myServices && myServices.console) {
        myServices.console.logStringMessage("CustomColumn: " + msg);
      }
    }
    return {
      customColumn: {
        async provideSnippet(msgId, snippet) {
            Services.console.logStringMessage("API RECVD: provideSnippet(" + msgId + ", " + snippet + ")");
            let win = Services.wm.getMostRecentWindow("mail:3pane");
            if (win && win._snippetCallbacks && win._snippetCallbacks.has(msgId)) {
                let cb = win._snippetCallbacks.get(msgId);
                cb(snippet);
                win._snippetCallbacks.delete(msgId);
            } else {
                Services.console.logStringMessage("API ERROR: No callback found in map for msgId " + msgId);
            }
        },
        async init() {
          let initLog = [];
          try {
            logMsg("init() called in backend!");
            initLog.push("Backend init started.");
            let windowListener = {
              onOpenWindow(xulWindow) {
                let window = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                                       .getInterface(Ci.nsIDOMWindow);
                window.addEventListener("load", function listener() {
                  window.removeEventListener("load", listener, false);
                  let winType = window.document.documentElement.getAttribute("windowtype");
                  logMsg("New window loaded with type: " + winType);
                  if (winType === "mail:3pane") {
                    modifyCardView(window);
                  }
                }, false);
              },
              onCloseWindow(xulWindow) {},
              onWindowTitleChange(xulWindow, newTitle) {}
            };
            
            myServices.wm.addListener(windowListener);
            
            logMsg("Checking for existing windows...");
            let allWindows = myServices.wm.getEnumerator(null);
            let found3Pane = false;
            while (allWindows.hasMoreElements()) {
              let win = allWindows.getNext();
              let docEl = win.document && win.document.documentElement;
              let winType = docEl ? docEl.getAttribute("windowtype") : "unknown";
              logMsg("Found existing window with type: " + winType);
              if (winType === "mail:3pane") {
                found3Pane = true;
                initLog.push("Found mail:3pane window.");
                await modifyCardView(win, initLog);
              }
            }
            if (!found3Pane) {
              logMsg("WARNING: No mail:3pane window was found during init.");
              initLog.push("WARNING: No mail:3pane found.");
            }
            return initLog.join(" | ");
          } catch (initErr) {
            logMsg("Error inside customColumn.init(): " + initErr);
            return "Error: " + initErr;
          }

          function modifyCardView(window, initLog) {
            return new Promise((resolve) => {
              function localLog(msg) {
                logMsg(msg);
                if (initLog) initLog.push(msg);
              }
              localLog("modifyCardView running!");
              
              let setupDone = false;
              let attempts = 0;
              
              function findShadowContainerWithCards(root) {
                if (!root) return null;
                
                // Check light DOM of this root first
                try {
                   let cards = Array.from(root.querySelectorAll('.card-container, tr[is="thread-card"]'));
                   if (cards.length > 0) return { root: root, cards: cards };
                } catch(e) {}
                
                // Search iframes and browsers
                try {
                   let iframes = root.querySelectorAll('iframe, browser');
                   for (let frame of iframes) {
                     try {
                        if (frame.contentDocument) {
                           let result = findShadowContainerWithCards(frame.contentDocument);
                           if (result) return result;
                        }
                     } catch(err) {}
                   }
                } catch(e) {}
                
                // Otherwise, search all elements that have a shadowRoot
                try {
                   let allElements = root.querySelectorAll('*');
                   for (let el of allElements) {
                     if (el.shadowRoot) {
                       let result = findShadowContainerWithCards(el.shadowRoot);
                       if (result && result.cards.length > 0) {
                         return result; // Found it inside this shadowRoot
                       }
                     }
                   }
                } catch(e) {}
                
                return null;
              }

              function checkAndSetup() {
                if (setupDone) return;
                attempts++;
                let document = window.document;
                
                let foundData = findShadowContainerWithCards(document.documentElement);
                
                if (!foundData) {
                  if (attempts > 20) {
                     localLog("Gave up waiting for cards to appear after 10 seconds.");
                     resolve();
                     return;
                  }
                  window.setTimeout(checkAndSetup, 500);
                  return;
                }
                
                setupDone = true;
                localLog("Found " + foundData.cards.length + " cards! Architecture verified.");
                
                let container = foundData.root;
                localLog("Using container root: " + (container.host ? container.host.tagName : container.tagName));

                let observer = new window.MutationObserver((mutations) => {
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
              
              // Bulletproof fallback: periodically scan for newly recycled rows (e.g. fast scrolling or folder switching)
              window.setInterval(() => {
                 try {
                     let cards = container.querySelectorAll('.card-container, tr[is="thread-card"]');
                     cards.forEach(c => addExcerptToCard(c));
                 } catch(e){}
              }, 500);
                
                if (foundData.cards.length > 0) {
                   let sample = foundData.cards[0];
                   localLog("Sample Card - class: '" + sample.className + "'");
                }
                for (let card of foundData.cards) {
                   addExcerptToCard(card);
                }
                resolve();
              }
              
              checkAndSetup();
            });
          }

          function addExcerptToCard(cardElement) {
               try {
                   let rowElement = cardElement.closest("tr");
                   if (!rowElement && cardElement.tagName === "TR") rowElement = cardElement;
                   let rowIndex = null;
                   
                   if (rowElement && rowElement.id && rowElement.id.startsWith("threadTree-row")) {
                       rowIndex = rowElement.id.replace("threadTree-row", "");
                   } else if (rowElement && rowElement.getAttribute("data-row")) {
                       rowIndex = rowElement.getAttribute("data-row");
                   } else if (cardElement.getAttribute("data-row")) {
                       rowIndex = cardElement.getAttribute("data-row");
                   }
                   
                   let msgHdr = null;
                   if (rowIndex !== null && rowElement && rowElement.view && typeof rowElement.view.getMsgHdrAt === "function") {
                     msgHdr = rowElement.view.getMsgHdrAt(parseInt(rowIndex, 10));
                   } else if (rowIndex !== null && window.gFolderDisplay && window.gFolderDisplay.view) {
                     msgHdr = window.gFolderDisplay.view.getMsgHdrAt(parseInt(rowIndex, 10));
                   } else if (rowElement && rowElement.msgHdr) {
                     msgHdr = rowElement.msgHdr;
                   } else if (cardElement.msgHdr) {
                     msgHdr = cardElement.msgHdr;
                   }
                   
                   let msgId = null;
                   if (msgHdr && extension.messageManager) {
                       try { msgId = extension.messageManager.convert(msgHdr).id; } catch(e){}
                   }
                   
                   let existingExcerpt = cardElement.querySelector('.custom-excerpt');
                   if (existingExcerpt) {
                       if (msgId && String(existingExcerpt.dataset.msgId) === String(msgId)) {
                           return; // Correct excerpt already present for this row
                       } else {
                           existingExcerpt.remove(); // Stale excerpt from recycled row
                       }
                   }
                   
                   if (!msgHdr) return;
                   
                   let excerptDiv = window.document.createElement("span");
                   excerptDiv.className = "custom-excerpt";
                   if (msgId) excerptDiv.dataset.msgId = msgId;
                   excerptDiv.style.cssText = "display: inline-block; flex: 1; margin-left: 8px; color: GrayText; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;";
                   excerptDiv.textContent = " - (Loading excerpt...)";
                   
                   let subjectContainer = cardElement.querySelector('.thread-card-subject-container') || cardElement.querySelector('.subject').parentNode;
                   if (subjectContainer) {
                       subjectContainer.appendChild(excerptDiv);
                   } else {
                       cardElement.appendChild(excerptDiv);
                   }
                   
                   if (msgId) {
                       window._snippetCallbacks.set(msgId, (snippet) => {
                           if (excerptDiv.parentElement) {
                               excerptDiv.textContent = " - " + snippet;
                           }
                       });
                       if (fireSnippetRequested) {
                           fireSnippetRequested.async(msgId);
                       }
                   } else {
                       excerptDiv.textContent = " - (No WebExt ID)";
                   }
               } catch (e) {
                   logMsg("Failed to add excerpt to card: " + e);
               }
          }
        },
        onSnippetRequested: new ExtensionCommon.EventManager({
          context,
          name: "customColumn.onSnippetRequested",
          register(fire) {
            Services.console.logStringMessage("EVENT FIRED: Listener registered!");
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
