// Injected into the chat page (mock backend today, chat.deepseek.com later — step 10).
// Exposes typeAndSend / extractLastResponse / editMessage / toggleWebSearch / waitForReady
// to the background service worker via chrome.runtime.onMessage.

(function () {
  const RESPONSE_TIMEOUT_MS = 60000;
  // Once an assistant message's text stops changing for this long, treat it as finished.
  // Needed for chat.deepseek.com, whose streaming-state markup is transient and undocumented
  // here — unlike the mock backend, which flags it with a plain ".generating" class we can
  // check directly (see readme.md section 10 on selector fallbacks + UI-change resilience).
  // Real-site testing found 1200ms too short: a longer streamed response (e.g. Clip Finder's
  // multi-clip JSON) can hit a brief mid-stream pause that looks like "done" but isn't,
  // truncating the captured text before its closing bracket. 2500ms trades a bit of latency
  // for a much lower false-positive rate.
  const STABLE_MS = 2500;

  // Multiple fallback selectors per element so both the mock backend and the real site
  // (chat.deepseek.com, reverse-engineered from saved pages — see deepseek.html in the
  // repo root) work without touching the calling code (readme.md section 10).
  const SELECTORS = {
    textarea: [
      '#chat-input',
      '[data-testid="chat-input"]',
      'textarea[placeholder="Message DeepSeek"]',
      'textarea[placeholder*="Message"]',
    ],
    sendButton: [
      '#send-btn',
      '[data-testid="send-button"]',
      'div[role="button"].ds-button--primary.ds-button--circle',
    ],
    webSearchToggle: ['#web-search-toggle', '[data-testid="web-search-toggle"]'],
    messageList: ['#messages', '[data-testid="message-list"]'],
    // The mock backend wraps assistant text in a bubble with a nested ".msg-text" node;
    // DeepSeek's ".ds-assistant-message-main-content" *is* the text container itself.
    assistantMessage: '.msg-assistant, .ds-assistant-message-main-content',
    editButton: '.msg-edit-btn',
    // The real site's edit-mode textarea, captured from its actual outerHTML.
    editTextarea: ['textarea[name="user query"]'],
  };

  // DeepSeek has no aria-label or data-testid on its icon-only hover-toolbar buttons (edit,
  // copy, etc.) — they're all the same generic ds-button component with different SVG icon
  // content. The path data is the only stable-ish fingerprint available; captured directly
  // from the pencil/edit icon's outerHTML. Brittle across a visual redesign, but that's true
  // of any selector here (see readme.md section 10 on UI-change resilience).
  const EDIT_ICON_PATH_PREFIX = 'M9.94076 1.34942C10.7047';
  // The edit-mode confirm button, unlike the icon buttons, does have visible text ("Send",
  // not "Save" — captured from its real outerHTML too).
  const EDIT_SEND_BUTTON_TEXT = 'send';

  function query(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findButtonByIconPath(root, pathPrefix) {
    const paths = root.querySelectorAll('svg path');
    for (const p of paths) {
      const d = p.getAttribute('d') || '';
      if (d.startsWith(pathPrefix)) return p.closest('[role="button"]');
    }
    return null;
  }

  function findButtonByText(root, text) {
    const buttons = root.querySelectorAll('[role="button"], button');
    for (const b of buttons) {
      if ((b.textContent || '').trim().toLowerCase() === text.toLowerCase()) return b;
    }
    return null;
  }

  // ".ds-message" matches both user and assistant bubbles on the real site — there's no
  // user-specific class, so user messages are identified by NOT containing the
  // assistant-content marker. The mock backend's ".msg-user" is already role-specific.
  function getUserMessageEls() {
    const mockEls = document.querySelectorAll('.msg-user');
    if (mockEls.length) return Array.from(mockEls);
    return Array.from(document.querySelectorAll('.ds-message')).filter(
      (el) => !el.querySelector('.ds-assistant-message-main-content')
    );
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR',
  ]);

  // Manually walks the DOM to build a plain-text version of a message, reconstructing
  // ```-fenced code blocks along the way. Two things push this past a plain .innerText:
  //  1. DeepSeek's rendered code blocks have no literal ``` markers at all (those are
  //     markdown *source* syntax, consumed by rendering) — .innerText on the whole
  //     message also picks up the code block's "Copy"/"Download" button label text,
  //     since that lives in a sibling banner div right next to the <pre>.
  //  2. .innerText requires the element to have live layout; a detached clone (the
  //     obvious way to strip the banner before reading .innerText) returns "" in Chrome.
  // So: walk the live DOM, special-case `.md-code-block` to emit a fenced block built
  // from just its `<pre>` content (skipping the banner), and insert '\n' after other
  // block-level elements the way rendered layout would.
  function serializeNode(node, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.classList && node.classList.contains('md-code-block')) {
      const pre = node.querySelector('pre');
      const code = (pre ? pre.textContent : '') || '';
      out.push(`\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n`);
      return; // don't descend — skips the banner's language label / Copy / Download text
    }

    for (const child of node.childNodes) serializeNode(child, out);
    if (BLOCK_TAGS.has(node.tagName)) out.push('\n');
  }

  function messageText(el) {
    const inner = el.querySelector('.msg-text');
    if (inner) return inner.innerText || inner.textContent || '';

    const out = [];
    serializeNode(el, out);
    return out
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  // How long we're willing to let simulated typing run before giving up and pasting the
  // rest instantly. A real paste is one native `input` event with the full value already
  // set — indistinguishable at the DOM level from an actual Ctrl+V, and pasting long text
  // (a system prompt, a code block) is completely ordinary human behavior. It reads as
  // less anomalous than a single message taking 60+ seconds of uniform robotic typing
  // under Chrome's background-tab throttling.
  const TYPE_TIME_BUDGET_MS = 10000;
  const AVG_CHUNK_CHARS = 3.5; // midpoint of the 2-5 char burst range below

  function pasteValue(el, text) {
    el.focus();
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Types in small random-sized bursts (2-5 chars) rather than one setTimeout per
  // character. A long primer is otherwise hundreds of individual timers, and Chrome
  // throttles setTimeout heavily in windows that lose OS focus — turning ~40s of typing
  // into minutes with no error, just silence. Bursts cut that timer count by ~70-80%
  // while staying just as human-plausible (people type in bursts, not metronomically).
  //
  // If typing this out is estimated to exceed TYPE_TIME_BUDGET_MS (or `instant` is set —
  // used for the long planner/executor primer messages, which no human types live), paste
  // the whole thing instantly instead of simulating keystrokes at all.
  async function typeIntoElement(el, text, { delayRange = [50, 150], instant = false } = {}) {
    const avgDelayMs = (delayRange[0] + delayRange[1]) / 2;
    const estimatedMs = (text.length / AVG_CHUNK_CHARS) * avgDelayMs;

    if (instant || estimatedMs > TYPE_TIME_BUDGET_MS) {
      pasteValue(el, text);
      return;
    }

    el.focus();
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let i = 0;
    while (i < text.length) {
      const chunkSize = Math.min(text.length - i, 2 + Math.floor(Math.random() * 4)); // 2-5 chars
      setNativeValue(el, el.value + text.slice(i, i + chunkSize));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      i += chunkSize;
      await sleep(randomBetween(delayRange[0], delayRange[1]));
    }
  }

  function waitForReadyState(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const textarea = query(SELECTORS.textarea);
        if (textarea && !textarea.disabled) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('Chat input never became ready.'));
        setTimeout(poll, 200);
      })();
    });
  }

  // DeepSeek cuts generation short on very long responses and shows a "Continue" button
  // instead of finishing. Without handling this, the response text simply stops changing
  // (generation paused, not done) and our stabilization detection below wrongly treats
  // that as "finished" — sending our next message while DeepSeek still has an incomplete,
  // paused response sitting there, which desyncs the conversation from what we think
  // happened. Confirmed against real chat.deepseek.com outerHTML.
  function findContinueButton() {
    return findButtonByText(document, 'continue');
  }

  // Waits for whatever assistant bubble is currently last in the DOM to finish
  // generating. Callers are expected to have just triggered a send/resubmit, which
  // synchronously appends a fresh assistant element before this is called.
  //
  // Detection has two tiers, chosen per poll tick based on what markup is present:
  //  1. Class-based (mock backend): the bubble gets a ".done" class the instant its
  //     final text is set, so we can trust and resolve on it immediately.
  //  2. Stabilization (real site, or any UI without a known done/generating class):
  //     treat the text as final once it hasn't changed for STABLE_MS. Slower (adds a
  //     fixed tail latency) but doesn't depend on guessing the site's streaming markup.
  function waitForAssistantSettle(timeoutMs = RESPONSE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastText = null;
      let lastChangeAt = Date.now();

      (function poll() {
        const continueBtn = findContinueButton();
        if (continueBtn) {
          continueBtn.click();
          // More content is about to stream in — don't let stale stabilization state
          // resolve early on the text as it stood before the click.
          lastText = null;
          lastChangeAt = Date.now();
          if (Date.now() - start > timeoutMs) {
            return reject(new Error('Timed out waiting for assistant response.'));
          }
          setTimeout(poll, 250);
          return;
        }

        const assistantMsgs = document.querySelectorAll(SELECTORS.assistantMessage);
        const last = assistantMsgs[assistantMsgs.length - 1];

        if (last) {
          if (last.classList.contains('done')) {
            return resolve(messageText(last));
          }
          if (!last.classList.contains('generating')) {
            const text = messageText(last);
            if (text) {
              if (text !== lastText) {
                lastText = text;
                lastChangeAt = Date.now();
              } else if (Date.now() - lastChangeAt >= STABLE_MS) {
                return resolve(text);
              }
            }
          }
        }

        if (Date.now() - start > timeoutMs) {
          return reject(new Error('Timed out waiting for assistant response.'));
        }
        setTimeout(poll, 250);
      })();
    });
  }

  async function typeAndSend(text, { instant = false, timeoutMs } = {}) {
    await waitForReadyState();
    const textarea = query(SELECTORS.textarea);
    const sendButton = query(SELECTORS.sendButton);
    if (!textarea || !sendButton) throw new Error('Could not locate chat input or send button.');

    await typeIntoElement(textarea, text, { instant });
    await sleep(randomBetween(200, 800));
    sendButton.click();

    const reply = await waitForAssistantSettle(timeoutMs || RESPONSE_TIMEOUT_MS);
    return { text: reply };
  }

  function extractLastResponse() {
    const assistantMsgs = document.querySelectorAll(SELECTORS.assistantMessage);
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (!last) return { text: '' };
    return { text: messageText(last) };
  }

  // Real-site edit UI is hover-revealed (readme.md section 9's migration flow needs this
  // to find and click a message's edit pencil), and its icon buttons carry no aria-label
  // or data-testid — see EDIT_ICON_PATH_PREFIX / findButtonByIconPath above for how those
  // get identified. Confirmed against actual chat.deepseek.com outerHTML.
  async function editMessage(index, newText, { timeoutMs } = {}) {
    const target = getUserMessageEls()[index];
    if (!target) throw new Error(`No user message at index ${index} to edit.`);

    // The edit pencil only renders in the DOM on hover on the real site.
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(150);

    const editBtn =
      target.querySelector(SELECTORS.editButton) ||
      findButtonByIconPath(target, EDIT_ICON_PATH_PREFIX) ||
      findButtonByIconPath(document, EDIT_ICON_PATH_PREFIX);
    if (!editBtn) throw new Error('Edit button not found on target message.');
    editBtn.click();
    await sleep(150);

    const textarea = target.querySelector('textarea') || query(SELECTORS.editTextarea);
    if (!textarea) throw new Error('Edit textarea did not appear.');
    await typeIntoElement(textarea, newText);

    const saveBtn =
      Array.from(target.querySelectorAll('button')).find((b) => /save/i.test(b.textContent)) ||
      findButtonByText(target, EDIT_SEND_BUTTON_TEXT) ||
      findButtonByText(document, EDIT_SEND_BUTTON_TEXT);
    if (!saveBtn) throw new Error('Save/Send button not found in edit mode.');

    saveBtn.click();

    const reply = await waitForAssistantSettle(timeoutMs || RESPONSE_TIMEOUT_MS);
    return { text: reply };
  }

  // DeepSeek's real toggle buttons ("DeepThink" reasoning mode, "Search" web search) share
  // the same hashed classes as everything else, but each has a visible text label in a
  // sibling span — that's the reliable anchor. Confirmed against real outerHTML.
  function findToggleButtonByLabel(label) {
    const candidates = document.querySelectorAll('[aria-pressed]');
    for (const el of candidates) {
      if ((el.textContent || '').trim().toLowerCase() === label.toLowerCase()) return el;
    }
    return null;
  }

  function toggleFeature(mockSelector, realLabel, enabled) {
    const btn = (mockSelector && query(mockSelector)) || findToggleButtonByLabel(realLabel);
    if (!btn) return { toggled: false };
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (pressed !== !!enabled) btn.click();
    return { toggled: true };
  }

  function toggleWebSearch(enabled) {
    return toggleFeature(SELECTORS.webSearchToggle, 'Search', enabled);
  }

  function toggleDeepThink(enabled) {
    return toggleFeature(null, 'DeepThink', enabled);
  }

  // Combined action so the orchestrator can request both toggles' desired state in one
  // round trip instead of two separate sendToTab calls before a fresh session's first
  // message (SPEC intent: use DeepThink + Search for the "where to cut" prompts — Clip
  // Finder and Movie Segmenter — so the model reasons harder about what makes a moment
  // hook a viewer, instead of just pattern-matching timestamps).
  function setToggles({ deepThink = false, webSearch = false } = {}) {
    return { deepThink: toggleDeepThink(deepThink), webSearch: toggleWebSearch(webSearch) };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'typeAndSend') {
      typeAndSend(request.text, { instant: request.instant, timeoutMs: request.timeoutMs })
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (request.action === 'extractLastResponse') {
      sendResponse(extractLastResponse());
      return false;
    }
    if (request.action === 'editMessage') {
      editMessage(request.index, request.newText, { timeoutMs: request.timeoutMs })
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (request.action === 'toggleWebSearch') {
      sendResponse(toggleWebSearch(request.enabled));
      return false;
    }
    if (request.action === 'toggleDeepThink') {
      sendResponse(toggleDeepThink(request.enabled));
      return false;
    }
    if (request.action === 'setToggles') {
      sendResponse(setToggles({ deepThink: request.deepThink, webSearch: request.webSearch }));
      return false;
    }
    if (request.action === 'waitForReady') {
      // Short internal budget: TabManager.waitForReady (background) re-sends this message
      // every 300ms in its own retry loop, so one slow/failed attempt here shouldn't eat
      // the whole outer timeout — that's what caused a single "not ready" to look like a
      // 30s hang against the real site.
      waitForReadyState(2000)
        .then(() => sendResponse({ ready: true }))
        .catch((err) => sendResponse({ ready: false, error: err.message }));
      return true;
    }
    return false;
  });
})();
