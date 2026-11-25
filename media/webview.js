import { Marked, Renderer } from "marked";

(function () {
  const vscode = acquireVsCodeApi();
  let currentState = null;
  let openPopover = null; // "history" | "quota" | "settings" | "perm" | "model" | null
  let lastLoadedSessionId = null;
  let draftSaveTimer = null;
  let historySearchQuery = "";
  let historySearchHits = [];
  let historySearchTimer = null;
  let pendingJumpMessageId = null;
  let dismissedAlertKey = "";
  let slashActiveIdx = 0;
  let slashCandidates = [];
  let isLoadingOlder = false;
  let scrollAnchor = null;
  let suppressAutoLoadUntil = 0;
  let lastRenderedListKey = "";
  let lastRenderedSessionId = "";
  let lastRenderedStartIndex = 0;
  let lastRenderedCount = 0;
  const renderedMsgCache = new Map();

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 识别常见代码/配置文件路径及行号引用（如 FML_FileStore.c:1818、main/foo.c:10-25、foo.h#L42）
  const KNOWN_EXTS = new Set([
    "c", "h", "cc", "hh", "cpp", "hpp", "cxx", "hxx", "ino",
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs",
    "java", "kt", "kts", "cs", "swift", "m", "mm", "rb", "php",
    "md", "markdown", "json", "jsonc", "yaml", "yml", "toml",
    "xml", "html", "htm", "css", "scss", "less", "vue", "svelte",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "cmake", "mk", "mak", "ld", "lds", "s", "asm", "proto",
    "sql", "txt", "ini", "cfg", "conf", "env", "csv", "log",
  ]);
  const SPECIAL_FILENAMES = new Set([
    "Makefile", "CMakeLists.txt", "Dockerfile", "Kconfig", "sdkconfig", "Kconfig.projbuild",
  ]);

  function parseFileReference(raw) {
    if (!raw) return null;
    const text = String(raw).trim();
    if (!text || text.length > 260 || /\s/.test(text)) return null;
    if (/^(https?:|mailto:|ftp:|data:)/i.test(text)) return null;

    let candidate = text;
    if (candidate.startsWith("file://")) {
      candidate = candidate.replace(/^file:\/\//, "");
    }

    let filePath = candidate;
    let startLine;
    let endLine;

    // 匹配 #L123 或 #L123-L145
    const hashMatch = candidate.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      filePath = hashMatch[1];
      startLine = Number(hashMatch[2]);
      if (hashMatch[3]) endLine = Number(hashMatch[3]);
    } else {
      // 匹配 :123、:123-145、:123:45
      const colonMatch = candidate.match(/^(.+?):(\d+)(?:-(\d+)|:(\d+))?$/);
      if (colonMatch) {
        filePath = colonMatch[1];
        startLine = Number(colonMatch[2]);
        if (colonMatch[3]) endLine = Number(colonMatch[3]);
      }
    }

    // 去掉可能残留的首尾引号或括号
    filePath = filePath.replace(/^["'`(<]+|[>"'`)]+$/g, "");
    if (!filePath || filePath.startsWith("-") || filePath.endsWith("/")) {
      return null;
    }

    const baseName = filePath.split("/").pop() || "";
    if (!baseName || baseName.startsWith(".")) {
      return null;
    }

    const isSpecial = SPECIAL_FILENAMES.has(baseName);
    const dotIdx = baseName.lastIndexOf(".");
    const ext = dotIdx > 0 ? baseName.slice(dotIdx + 1).toLowerCase() : "";
    if (!isSpecial && !KNOWN_EXTS.has(ext)) {
      return null;
    }

    return {
      filePath,
      startLine: Number.isFinite(startLine) && startLine > 0 ? startLine : undefined,
      endLine: Number.isFinite(endLine) && endLine > 0 ? endLine : undefined,
    };
  }

  // 配置支持 GFM 表格、有序列表、任务列表且禁用原始 HTML 注入的安全 Markdown 渲染器
  const mdRenderer = new Renderer();

  mdRenderer.html = function (token) {
    return escapeHtml(token.text ?? token.raw ?? "");
  };

  mdRenderer.codespan = function (token) {
    const rawText = token.text ?? "";
    const ref = parseFileReference(rawText);
    if (ref) {
      const lineHint = ref.startLine
        ? ref.endLine
          ? " 第 " + ref.startLine + "-" + ref.endLine + " 行"
          : " 第 " + ref.startLine + " 行"
        : "";
      const tip = "点击在 VS Code 中跳转：" + ref.filePath + lineHint;
      return (
        '<code class="code-ref" data-open-file="' +
        escapeHtml(ref.filePath) +
        '" data-open-line="' +
        (ref.startLine || "") +
        '" data-open-end-line="' +
        (ref.endLine || "") +
        '" title="' +
        escapeHtml(tip) +
        '">' +
        escapeHtml(rawText) +
        "</code>"
      );
    }
    return "<code>" + escapeHtml(rawText) + "</code>";
  };

  mdRenderer.code = function (token) {
    const lang = (token.lang || "text").trim();
    const code = token.text ?? "";
    const encoded = encodeURIComponent(code);
    return (
      '<div class="code-block">' +
      '<div class="code-head"><span>' + escapeHtml(lang) + "</span>" +
      '<button class="copy-btn" data-copy="' + encoded + '">Copy</button></div>' +
      "<pre><code>" + escapeHtml(code) + "</code></pre></div>"
    );
  };

  mdRenderer.table = function (token) {
    return (
      '<div class="table-wrap">' +
      Renderer.prototype.table.call(this, token) +
      "</div>"
    );
  };

  mdRenderer.link = function (token) {
    const href = String(token.href ?? "");
    const label = this.parser.parseInline(token.tokens);
    // 拦截本地文件链接（file:// 或相对文件路径），支持点击直接跳转到对应行
    const fileRef = parseFileReference(href);
    if (fileRef) {
      return (
        '<a href="#" data-open-file="' +
        escapeHtml(fileRef.filePath) +
        '" data-open-line="' +
        (fileRef.startLine || "") +
        '" data-open-end-line="' +
        (fileRef.endLine || "") +
        '">' +
        label +
        "</a>"
      );
    }
    const safe = /^(https?:|mailto:)/i.test(href);
    if (!safe) {
      return label;
    }
    const titleAttr = token.title ? ' title="' + escapeHtml(token.title) + '"' : "";
    return '<a href="' + escapeHtml(href) + '"' + titleAttr + ">" + label + "</a>";
  };

  const markedInstance = new Marked({
    gfm: true,
    breaks: true,
    renderer: mdRenderer,
  });

  const sessionTrigger = document.getElementById("sessionTrigger");
  const sessionTitleText = document.getElementById("sessionTitleText");
  const quotaBtn = document.getElementById("quotaBtn");
  const quotaText = document.getElementById("quotaText");
  const statusBtn = document.getElementById("statusBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const historyPopover = document.getElementById("historyPopover");
  const historySearchInput = document.getElementById("historySearchInput");
  const historySearchClear = document.getElementById("historySearchClear");
  const historyListBody = document.getElementById("historyListBody");
  const searchHistoryBtn = document.getElementById("searchHistoryBtn");
  const tabStrip = document.getElementById("tabStrip");
  const slashPopover = document.getElementById("slashPopover");
  const cacheAlertBar = document.getElementById("cacheAlertBar");
  const handoffBtn = document.getElementById("handoffBtn");
  const quotaPopover = document.getElementById("quotaPopover");
  const serverPopover = document.getElementById("serverPopover");
  const settingsPopover = document.getElementById("settingsPopover");
  const permPopover = document.getElementById("permPopover");
  const modelPopover = document.getElementById("modelPopover");
  const permBtn = document.getElementById("permBtn");
  const permBtnLabel = document.getElementById("permBtnLabel");
  const modelBtn = document.getElementById("modelBtn");
  const modelBtnLabel = document.getElementById("modelBtnLabel");
  const messagesEl = document.getElementById("messages");
  const composerContext = document.getElementById("composerContext");
  const promptInput = document.getElementById("promptInput");
  const sendBtn = document.getElementById("sendBtn");

  const PERM_OPTIONS = [
    {
      value: "bypassPermissions",
      short: "Bypass permissions",
      title: "全部允许 (Bypass)",
      desc: "自动读写本地文件并执行命令，配合 Git 随时可撤回",
      cls: "mode-bypass",
    },
    {
      value: "acceptEdits",
      short: "Accept edits",
      title: "自动改文件 (Accept Edits)",
      desc: "自动放行文件编辑，限制其他危险操作",
      cls: "mode-accept",
    },
    {
      value: "plan",
      short: "Plan mode",
      title: "只读规划 (Plan)",
      desc: "只读代码与制定方案，不改动任何文件",
      cls: "mode-plan",
    },
    {
      value: "dontAsk",
      short: "Restricted",
      title: "严格受限 (DontAsk)",
      desc: "未预先白名单的工具自动拒绝",
      cls: "mode-dontAsk",
    },
  ];

  const MODEL_OPTIONS = [
    { value: "", short: "Default", title: "Default", desc: "跟随远程 EC2 默认配置" },
    { value: "claude-opus-5-5", short: "claude-opus-5-5", title: "claude-opus-5-5", desc: "最强推理与复杂架构分析" },
    { value: "claude-fable-5-2[1m]", short: "claude-fable-5-2[1m]", title: "claude-fable-5-2[1m]", desc: "Fable 5.2 · 1M 超长上下文" },
    { value: "claude-sonnet-5-5", short: "claude-sonnet-5-5", title: "claude-sonnet-5-5", desc: "日常开发速度与质量均衡" },
    { value: "claude-haiku-5-5", short: "claude-haiku-5-5", title: "claude-haiku-5-5", desc: "极速轻量问答" },
  ];

  const EFFORT_OPTIONS = [
    { value: "", label: "Default", desc: "默认" },
    { value: "low", label: "low", desc: "低 · 最快" },
    { value: "medium", label: "medium", desc: "中 · 均衡" },
    { value: "high", label: "high", desc: "高 · 深入" },
    { value: "xhigh", label: "xhigh", desc: "超高 · 复杂" },
    { value: "max", label: "max", desc: "极限 · 最深" },
  ];

  const ICON_SEND =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  const ICON_STOP =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2.5"/></svg>';
  const ICON_STAR =
    '<svg width="24" height="19" viewBox="0 0 18 14" fill="currentColor" shape-rendering="crispEdges"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 1H16V4H18V7H16V9H15V13H13V9H12V13H10V9H8V13H6V9H5V13H3V9H2V7H0V4H2V1ZM5 4V6H7V4H5ZM11 4V6H13V4H11Z"/></svg>';
  const ICON_STAR_SM =
    '<svg width="16" height="13" viewBox="0 0 18 14" fill="currentColor" shape-rendering="crispEdges"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 1H16V4H18V7H16V9H15V13H13V9H12V13H10V9H8V13H6V9H5V13H3V9H2V7H0V4H2V1ZM5 4V6H7V4H5ZM11 4V6H13V4H11Z"/></svg>';
  const ICON_BRANCH =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  const ICON_COPY =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_REFRESH =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

  function togglePopover(name) {
    openPopover = openPopover === name ? null : name;
    historyPopover.classList.toggle("open", openPopover === "history");
    quotaPopover.classList.toggle("open", openPopover === "quota");
    serverPopover.classList.toggle("open", openPopover === "server");
    settingsPopover.classList.toggle("open", openPopover === "settings");
    permPopover.classList.toggle("open", openPopover === "perm");
    modelPopover.classList.toggle("open", openPopover === "model");
  }

  function closePopovers() {
    if (!openPopover) return;
    openPopover = null;
    historyPopover.classList.remove("open");
    quotaPopover.classList.remove("open");
    serverPopover.classList.remove("open");
    settingsPopover.classList.remove("open");
    permPopover.classList.remove("open");
    modelPopover.classList.remove("open");
  }

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (
      target.closest(".popover") ||
      target.closest("#sessionTrigger") ||
      target.closest("#searchHistoryBtn") ||
      target.closest("#quotaBtn") ||
      target.closest("#statusBtn") ||
      target.closest("#settingsBtn") ||
      target.closest("#permBtn") ||
      target.closest("#modelBtn") ||
      target.closest("#promptInput")
    ) {
      return;
    }
    closePopovers();
    hideSlashPopover();
  });

  sessionTrigger.addEventListener("click", () => {
    togglePopover("history");
    if (openPopover === "history" && historySearchInput && historySearchQuery) {
      historySearchInput.focus();
    }
  });

  if (searchHistoryBtn) {
    searchHistoryBtn.addEventListener("click", () => {
      if (openPopover !== "history") {
        togglePopover("history");
      }
      if (historySearchInput) {
        historySearchInput.focus();
        historySearchInput.select();
      }
    });
  }

  if (historySearchInput) {
    historySearchInput.addEventListener("input", () => {
      historySearchQuery = historySearchInput.value.trim();
      if (historySearchClear) {
        historySearchClear.style.display = historySearchQuery ? "inline-flex" : "none";
      }
      if (historySearchTimer) clearTimeout(historySearchTimer);
      if (!historySearchQuery) {
        historySearchHits = [];
        if (currentState) renderHistoryBody(currentState);
        return;
      }
      historySearchTimer = setTimeout(() => {
        vscode.postMessage({ type: "searchHistory", query: historySearchQuery });
      }, 130);
    });

    historySearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (historySearchQuery) {
          historySearchInput.value = "";
          historySearchQuery = "";
          historySearchHits = [];
          if (historySearchClear) historySearchClear.style.display = "none";
          if (currentState) renderHistoryBody(currentState);
        } else {
          closePopovers();
        }
      }
    });
  }

  if (historySearchClear) {
    historySearchClear.addEventListener("click", () => {
      if (historySearchInput) {
        historySearchInput.value = "";
        historySearchInput.focus();
      }
      historySearchQuery = "";
      historySearchHits = [];
      historySearchClear.style.display = "none";
      if (currentState) renderHistoryBody(currentState);
    });
  }

  if (handoffBtn) {
    handoffBtn.addEventListener("click", () => {
      if (!currentState || currentState.isRunning || currentState.isHandingOff) return;
      flushDraftNow();
      vscode.postMessage({ type: "handoffSession" });
    });
  }

  // 微信式上滑自动加载更早聊天记录（滑近顶部自动静默加载并锚定阅读位置，不跳屏）
  messagesEl.addEventListener("scroll", () => {
    if (!currentState || !currentState.hasMoreOlder || isLoadingOlder) return;
    if (Date.now() < suppressAutoLoadUntil) return;
    if (messagesEl.scrollHeight <= messagesEl.clientHeight + 80) return;
    if (messagesEl.scrollTop < 120) {
      isLoadingOlder = true;
      scrollAnchor = {
        prevHeight: messagesEl.scrollHeight,
        prevTop: messagesEl.scrollTop,
      };
      const sentinel = messagesEl.querySelector(".older-sentinel");
      if (sentinel) {
        sentinel.textContent = "正在加载更早记录...";
      }
      vscode.postMessage({ type: "loadMoreMessages", step: 20 });
    }
  });
  quotaBtn.addEventListener("click", () => {
    togglePopover("quota");
    if (openPopover === "quota" && (!currentState || !currentState.quota)) {
      vscode.postMessage({ type: "refreshQuota" });
    }
  });
  permBtn.addEventListener("click", () => togglePopover("perm"));
  modelBtn.addEventListener("click", () => togglePopover("model"));

  statusBtn.addEventListener("click", () => {
    togglePopover("server");
  });

  document.getElementById("newChatBtn").addEventListener("click", () => {
    flushDraftNow();
    closePopovers();
    vscode.postMessage({ type: "newSession" });
  });

  document.getElementById("terminalBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openTerminal" });
  });

  document.getElementById("settingsBtn").addEventListener("click", () => {
    togglePopover("settings");
  });

  document.getElementById("attachBtn").addEventListener("click", () => {
    const hasSel = currentState && currentState.activeEditor && currentState.activeEditor.hasSelection;
    vscode.postMessage({ type: hasSel ? "addSelection" : "addCurrentFile" });
  });

  function updateSendVisual() {
    const running = Boolean(currentState && currentState.isRunning);
    if (running) {
      sendBtn.innerHTML = ICON_STOP;
      sendBtn.className = "send-circle stop";
      sendBtn.title = "停止生成";
      return;
    }
    const hasInput =
      promptInput.value.trim().length > 0 ||
      Boolean(currentState && currentState.attachments && currentState.attachments.length > 0);
    sendBtn.innerHTML = ICON_SEND;
    sendBtn.className = hasInput ? "send-circle" : "send-circle muted";
    sendBtn.title = "发送 (Enter)";
  }

  function flushDraftNow() {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    const sid = currentState && currentState.activeSession && currentState.activeSession.id;
    if (!sid) return;
    vscode.postMessage({
      type: "saveDraft",
      sessionId: sid,
      text: promptInput.value,
    });
  }

  function scheduleDraftSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      flushDraftNow();
    }, 300);
  }

  function triggerSend() {
    if (currentState && currentState.isRunning) {
      vscode.postMessage({ type: "stop" });
      return;
    }
    const text = promptInput.value.trim();
    const hasAtt = currentState && currentState.attachments && currentState.attachments.length > 0;
    if (!text && !hasAtt) {
      return;
    }
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    promptInput.value = "";
    autoResize();
    updateSendVisual();
    vscode.postMessage({ type: "send", text });
  }

  function hideSlashPopover() {
    if (slashPopover) {
      slashPopover.classList.remove("open");
    }
    slashCandidates = [];
    slashActiveIdx = 0;
  }

  function applySlashSelection(cmd) {
    if (!cmd) return;
    promptInput.value = "/" + cmd.name + " ";
    hideSlashPopover();
    autoResize();
    updateSendVisual();
    scheduleDraftSave();
    promptInput.focus();
  }

  function updateSlashPopover() {
    if (!slashPopover) return;
    const raw = promptInput.value || "";
    const match = raw.match(/^\/([a-zA-Z0-9_-]*)$/);
    if (!match) {
      hideSlashPopover();
      return;
    }
    const kw = match[1].toLowerCase();
    const skillItems = ((currentState && currentState.skills) || []).map((sk) => ({
      name: sk.name,
      desc: sk.description || "本地 Skill",
      tag: "Skill",
    }));
    const builtins = [
      { name: "compact", desc: "在当前会话原地压缩上下文（官方内置）", tag: "内置" },
    ];
    const all = [...skillItems, ...builtins];
    slashCandidates = all.filter(
      (item) =>
        !kw ||
        item.name.toLowerCase().includes(kw) ||
        item.desc.toLowerCase().includes(kw)
    );
    if (slashCandidates.length === 0) {
      hideSlashPopover();
      return;
    }
    if (slashActiveIdx >= slashCandidates.length) {
      slashActiveIdx = 0;
    }
    slashPopover.innerHTML =
      '<div class="popover-header"><span>快捷选择 Skill / 命令（↑↓ 选择，Enter 填入）</span><span>' + slashCandidates.length + "</span></div>" +
      slashCandidates
        .map(
          (item, idx) =>
            '<div class="slash-item ' + (idx === slashActiveIdx ? "active" : "") + '" data-slash-idx="' + idx + '">' +
            '<div class="slash-item-top">' +
            '<span class="slash-item-name">/' + escapeHtml(item.name) + "</span>" +
            '<span class="slash-item-tag">' + escapeHtml(item.tag) + "</span>" +
            "</div>" +
            '<div class="slash-item-desc">' + escapeHtml(item.desc) + "</div>" +
            "</div>"
        )
        .join("");
    slashPopover.classList.add("open");

    slashPopover.querySelectorAll("[data-slash-idx]").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const idx = Number(el.dataset.slashIdx);
        applySlashSelection(slashCandidates[idx]);
      });
    });
  }

  sendBtn.addEventListener("click", triggerSend);
  promptInput.addEventListener("keydown", (e) => {
    if (slashPopover && slashPopover.classList.contains("open") && slashCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashActiveIdx = (slashActiveIdx + 1) % slashCandidates.length;
        updateSlashPopover();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashActiveIdx = (slashActiveIdx - 1 + slashCandidates.length) % slashCandidates.length;
        updateSlashPopover();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) {
        e.preventDefault();
        applySlashSelection(slashCandidates[slashActiveIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlashPopover();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      triggerSend();
    }
  });
  promptInput.addEventListener("input", () => {
    autoResize();
    updateSendVisual();
    scheduleDraftSave();
    updateSlashPopover();
  });
  promptInput.addEventListener("blur", () => {
    flushDraftNow();
  });
  window.addEventListener("pagehide", () => {
    flushDraftNow();
  });

  function autoResize() {
    promptInput.style.height = "44px";
    promptInput.style.height = Math.min(180, promptInput.scrollHeight) + "px";
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "state") {
      currentState = msg.payload;
      render(currentState);
    } else if (msg.type === "restoreDraft") {
      promptInput.value = msg.text || "";
      autoResize();
      updateSendVisual();
      promptInput.focus();
    } else if (msg.type === "searchResults") {
      if ((msg.query || "").trim() === historySearchQuery) {
        historySearchHits = Array.isArray(msg.hits) ? msg.hits : [];
        if (currentState) {
          renderHistoryBody(currentState);
        }
      }
    }
  });

  // 每 30 秒刷新一次缓存冷热预警条，午休回来不动键盘也会自动亮起防踩坑提示
  setInterval(() => {
    if (currentState) {
      renderCacheAlert(currentState);
    }
  }, 30000);

  function shortPath(fullPath, workspacePath) {
    if (!fullPath) return "";
    if (workspacePath && fullPath.startsWith(workspacePath + "/")) {
      return fullPath.slice(workspacePath.length + 1);
    }
    const parts = fullPath.split("/");
    return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : fullPath;
  }

  function formatToolVerb(toolName) {
    const map = {
      mcp__devspace__open_workspace: "Workspace",
      mcp__devspace__read: "Read",
      mcp__devspace__edit: "Edit",
      mcp__devspace__write: "Write",
      mcp__devspace__bash: "Bash",
      mcp__devspace__show_changes: "Diff",
    };
    return map[toolName] || toolName.replace(/^mcp__devspace__/, "");
  }

  function renderMarkdown(raw) {
    if (!raw) return "";
    try {
      return String(markedInstance.parse(raw));
    } catch {
      return "<p>" + escapeHtml(raw).replace(/\r?\n/g, "<br/>") + "</p>";
    }
  }

  function formatTokens(n) {
    if (!n || n <= 0) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return Math.round(n / 1_000) + "K";
    return String(n);
  }

  function formatResetHint(resetsAtSec) {
    if (!resetsAtSec) return "";
    const diffMs = resetsAtSec * 1000 - Date.now();
    if (diffMs <= 0) {
      return "已过重置时间，待下次对话刷新";
    }
    const totalMin = Math.ceil(diffMs / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    const d = new Date(resetsAtSec * 1000);
    const pad = (v) => String(v).padStart(2, "0");
    const clock = pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (days > 0) {
      return days + "天" + hours + "小时后重置 (" + clock + ")";
    }
    if (hours > 0) {
      return hours + "小时" + mins + "分后重置 (" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ")";
    }
    return mins + "分钟后重置";
  }

  function renderQuotaPopover(state) {
    const q = state.quota;
    // 更新顶栏小胶囊
    quotaBtn.className = "quota-pill";
    if (!q || (!q.fiveHour && !q.sevenDay)) {
      quotaText.textContent = "额度";
    } else if (q.fiveHour) {
      const expired = q.fiveHour.resetsAt && q.fiveHour.resetsAt * 1000 <= Date.now();
      const pct = Math.min(100, Math.max(0, Math.round(q.fiveHour.utilization * 100)));
      if (expired) {
        quotaText.textContent = "5h 已重置";
      } else {
        quotaText.textContent = "5h " + pct + "%";
        if (pct >= 95) quotaBtn.classList.add("danger");
        else if (pct >= 80) quotaBtn.classList.add("warn");
      }
    } else if (q.sevenDay) {
      const pct = Math.min(100, Math.max(0, Math.round(q.sevenDay.utilization * 100)));
      quotaText.textContent = "7d " + pct + "%";
    }

    const updatedLabel = state.isRefreshingQuota
      ? "正在查询..."
      : q && q.updatedAt
        ? "更新于 " + new Date(q.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "未获取";

    let bodyHtml = "";
    if (!q || (!q.fiveHour && !q.sevenDay && !q.lastContextTokens)) {
      bodyHtml =
        '<div class="quota-empty">' +
        (state.isRefreshingQuota
          ? "正在后台静默获取远程 Claude 额度..."
          : "点击右上角刷新图标即可在后台静默获取实时 5 小时 / 7 天额度（0 Token，不弹终端）。") +
        "</div>";
    } else {
      const renderBar = (label, win) => {
        if (!win) return "";
        const expired = win.resetsAt && win.resetsAt * 1000 <= Date.now();
        const pct = expired ? 0 : Math.min(100, Math.max(0, Math.round(win.utilization * 100)));
        const cls = pct >= 95 ? "danger" : pct >= 80 ? "warn" : "";
        return (
          '<div class="quota-row">' +
          '<div class="quota-row-top"><span class="quota-row-label">' + label + '</span><span class="quota-row-val">已用 ' + pct + "%</span></div>" +
          '<div class="quota-bar-track"><div class="quota-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
          (win.resetsAt ? '<div class="quota-reset">' + escapeHtml(formatResetHint(win.resetsAt)) + "</div>" : "") +
          "</div>"
        );
      };

      if (Array.isArray(q.secondaryPools) && q.secondaryPools.length > 0) {
        for (const pool of q.secondaryPools) {
          bodyHtml += renderBar(pool.label + " · 5 小时额度", pool.fiveHour);
          bodyHtml += renderBar(pool.label + " · 7 天额度", pool.sevenDay);
        }
      } else {
        bodyHtml += renderBar("5 小时滚动额度", q.fiveHour);
        bodyHtml += renderBar("7 天周期额度", q.sevenDay);
      }

      if (q.lastContextTokens && q.lastContextWindow) {
        const ctxPct = Math.min(
          100,
          Math.round((q.lastContextTokens / q.lastContextWindow) * 1000) / 10
        );
        const cls = ctxPct >= 85 ? "danger" : ctxPct >= 65 ? "warn" : "";
        bodyHtml +=
          '<div class="quota-row">' +
          '<div class="quota-row-top"><span class="quota-row-label">最近上下文</span><span class="quota-row-val">' +
          formatTokens(q.lastContextTokens) + " / " + formatTokens(q.lastContextWindow) + " (" + ctxPct + "%)</span></div>" +
          '<div class="quota-bar-track"><div class="quota-bar-fill ' + cls + '" style="width:' + Math.min(100, ctxPct) + '%"></div></div>' +
          "</div>";
      }
    }

    const quotaHeadTitle =
      state.engine === "antigravity" ? "Antigravity 实时额度" : "Claude 实时额度";
    quotaPopover.innerHTML =
      '<div class="quota-head">' +
      '<span class="quota-head-title">' + quotaHeadTitle + "</span>" +
      '<span class="quota-head-right">' +
      '<span class="quota-head-time">' + escapeHtml(updatedLabel) + "</span>" +
      '<button class="quota-refresh-btn ' + (state.isRefreshingQuota ? "spinning" : "") + '" id="quotaRefreshBtn" title="后台静默刷新额度 (0 Token)">' + ICON_REFRESH + "</button>" +
      "</span></div>" +
      bodyHtml;

    const refreshBtn = document.getElementById("quotaRefreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "refreshQuota" });
      });
    }
  }

  const THEME_OPTIONS = [
    { value: "claude", label: "Claude", color: "#d97757" },
    { value: "wechat", label: "微信", color: "#07c160" },
    { value: "feishu", label: "飞书", color: "#3370ff" },
    { value: "vscode", label: "跟随 VS Code", color: "#8e8e93" },
  ];

  function applyChatTheme(theme) {
    const valid = THEME_OPTIONS.some((t) => t.value === theme) ? theme : "claude";
    document.body.dataset.theme = valid;
  }

  function renderSettingsPopover(state) {
    const syncOn = Boolean(state.syncLocalRules);
    const activeTheme = state.chatTheme || "claude";
    const themeChipsHtml = THEME_OPTIONS.map((t) => {
      const sel = t.value === activeTheme;
      return (
        '<button type="button" class="theme-chip ' + (sel ? "active" : "") + '" data-chat-theme="' + t.value + '">' +
        '<span class="theme-dot" style="background:' + t.color + '"></span>' +
        "<span>" + t.label + "</span>" +
        "</button>"
      );
    }).join("");

    settingsPopover.innerHTML =
      '<div class="theme-picker-block">' +
      '<div class="theme-picker-title">界面主题（含 Markdown 样式）</div>' +
      '<div class="theme-picker-grid">' + themeChipsHtml + "</div>" +
      "</div>" +
      '<div class="popover-divider"></div>' +
      '<div class="setting-row" id="openFullSettingsRow">' +
      '<div class="setting-row-text">' +
      '<span class="setting-row-title">打开可视化设置中心...</span>' +
      '<span class="setting-row-desc">服务器、规则、Skill 库、记忆与习惯提炼</span>' +
      "</div>" +
      "</div>" +
      '<div class="setting-row" id="openWizardRow">' +
      '<div class="setting-row-text">' +
      '<span class="setting-row-title">新机配置向导 (4 步部署)</span>' +
      '<span class="setting-row-desc">一键配置新 VPS 与免客户端网页登录画面</span>' +
      "</div>" +
      "</div>" +
      '<div class="setting-row" id="openLogFileRow">' +
      '<div class="setting-row-text">' +
      '<span class="setting-row-title">查看诊断日志 (bridge.log)</span>' +
      '<span class="setting-row-desc">排查断线原因、网络耗时与代理状态</span>' +
      "</div>" +
      "</div>";

    settingsPopover.querySelectorAll("[data-chat-theme]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextTheme = btn.dataset.chatTheme || "claude";
        applyChatTheme(nextTheme);
        if (currentState) currentState.chatTheme = nextTheme;
        renderSettingsPopover(currentState || { chatTheme: nextTheme });
        vscode.postMessage({ type: "setChatTheme", theme: nextTheme });
      });
    });

    const openLogRow = document.getElementById("openLogFileRow");
    if (openLogRow) {
      openLogRow.addEventListener("click", () => {
        closePopovers();
        vscode.postMessage({ type: "openLogFile" });
      });
    }
    const openFullRow = document.getElementById("openFullSettingsRow");
    if (openFullRow) {
      openFullRow.addEventListener("click", () => {
        closePopovers();
        vscode.postMessage({ type: "openSettings" });
      });
    }
    const openWizardRow = document.getElementById("openWizardRow");
    if (openWizardRow) {
      openWizardRow.addEventListener("click", () => {
        closePopovers();
        vscode.postMessage({ type: "openSetupWizard" });
      });
    }
  }

  function renderServerPopover(state) {
    const profiles = state.profiles || [];
    const activeId = (state.activeProfile && state.activeProfile.id) || "default";
    const listHtml = profiles
      .map((p) => {
        const selected = p.id === activeId;
        const engTag = p.engine === "antigravity" ? "AGY" : "Claude";
        const portTag = p.remotePort && Number(p.remotePort) !== 7676 ? ":" + p.remotePort : "";
        const quotaBadge =
          typeof p.quota5h === "number" ? " · 5h " + p.quota5h + "%" : "";
        const desc = engTag + " · " + (p.sshHost || "未配置 IP") + portTag + quotaBadge;
        return (
          '<div class="menu-option ' + (selected ? "selected" : "") + '" data-switch-profile="' + escapeHtml(p.id) + '">' +
          '<div class="menu-opt-text">' +
          '<span class="menu-opt-title">' + escapeHtml(p.name) + "</span>" +
          '<span class="menu-opt-desc">' + escapeHtml(desc) + "</span>" +
          "</div>" +
          '<span class="menu-check">' + (selected ? "✓" : "") + "</span>" +
          "</div>"
        );
      })
      .join("");

    serverPopover.innerHTML =
      '<div class="popover-header"><span>切换远程服务器</span><span>' + profiles.length + "</span></div>" +
      listHtml +
      '<div class="popover-divider"></div>' +
      '<div class="setting-row" id="srvReconnectRow"><div class="setting-row-text"><span class="setting-row-title">刷新重连当前服务器</span></div></div>' +
      '<div class="setting-row" id="srvManageRow"><div class="setting-row-text"><span class="setting-row-title">管理 / 新增服务器...</span></div></div>';

    serverPopover.querySelectorAll("[data-switch-profile]").forEach((el) => {
      el.addEventListener("click", () => {
        const pid = el.dataset.switchProfile;
        closePopovers();
        if (pid && pid !== activeId) {
          flushDraftNow();
          vscode.postMessage({ type: "switchProfile", profileId: pid });
        }
      });
    });

    const reconRow = document.getElementById("srvReconnectRow");
    if (reconRow) {
      reconRow.addEventListener("click", () => {
        closePopovers();
        vscode.postMessage({ type: "connect", force: true });
      });
    }
    const manageRow = document.getElementById("srvManageRow");
    if (manageRow) {
      manageRow.addEventListener("click", () => {
        closePopovers();
        vscode.postMessage({ type: "openSettings" });
      });
    }
  }

  function formatShortTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return mm + "-" + dd + " " + hh + ":" + mi;
  }

  function highlightSearchSnippet(snippet, query) {
    const escaped = escapeHtml(snippet || "");
    const terms = (query || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!terms.length) return escaped;
    const pattern = terms
      .map((t) => escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    try {
      return escaped.replace(
        new RegExp("(" + pattern + ")", "gi"),
        '<mark class="search-mark">$1</mark>'
      );
    } catch {
      return escaped;
    }
  }

  function jumpToMessageById(msgId) {
    if (!msgId) return false;
    const all = messagesEl.querySelectorAll("[data-msg-id]");
    let targetEl = null;
    for (const el of all) {
      if (el.dataset.msgId === msgId) {
        targetEl = el;
        break;
      }
    }
    if (!targetEl) return false;
    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
    targetEl.classList.remove("msg-jump-highlight");
    void targetEl.offsetWidth;
    targetEl.classList.add("msg-jump-highlight");
    setTimeout(() => {
      targetEl.classList.remove("msg-jump-highlight");
    }, 2600);
    return true;
  }

  function renderHistoryBody(state) {
    if (!historyListBody) return;
    const showProfileTag = (state.profiles || []).length > 1;

    if (historySearchQuery) {
      if (!historySearchHits.length) {
        historyListBody.innerHTML =
          '<div class="popover-header"><span>搜索结果</span><span>0 条</span></div>' +
          '<div class="history-empty">没有找到包含「' + escapeHtml(historySearchQuery) + "」的历史记录，换个关键词试试。</div>";
        return;
      }
      const hitsHtml = historySearchHits
        .map((h) => {
          const roleLabel = h.role === "user" ? "我" : "Claude";
          const roleCls = h.role === "user" ? "user" : "assistant";
          const metaParts = [h.sessionTitle];
          if (showProfileTag && h.profileName) metaParts.push(h.profileName);
          if (h.timestamp) metaParts.push(formatShortTime(h.timestamp));
          return (
            '<div class="search-hit-item" data-hit-sid="' + escapeHtml(h.sessionId) + '" data-hit-mid="' + escapeHtml(h.messageId) + '">' +
            '<div class="search-hit-meta">' +
            '<span class="search-hit-role ' + roleCls + '">' + roleLabel + "</span>" +
            '<span class="search-hit-session">' + escapeHtml(metaParts.join(" · ")) + "</span>" +
            "</div>" +
            '<div class="search-hit-snippet">' + highlightSearchSnippet(h.snippet, historySearchQuery) + "</div>" +
            "</div>"
          );
        })
        .join("");

      historyListBody.innerHTML =
        '<div class="popover-header"><span>跨会话搜索结果（点一条直达原文）</span><span>' + historySearchHits.length + " 条</span></div>" +
        hitsHtml;

      historyListBody.querySelectorAll("[data-hit-sid]").forEach((el) => {
        el.addEventListener("click", () => {
          const sid = el.dataset.hitSid;
          const mid = el.dataset.hitMid;
          closePopovers();
          if (sid && state.activeSession && sid === state.activeSession.id && jumpToMessageById(mid)) {
            return;
          }
          if (sid) {
            pendingJumpMessageId = mid || null;
            flushDraftNow();
            vscode.postMessage({ type: "jumpToMessage", sessionId: sid, messageId: mid });
          }
        });
      });
      return;
    }

    const listHtml = (state.sessions || [])
      .map((s) => {
        const isActive = s.id === state.activeSession.id;
        const subParts = [];
        if (showProfileTag && s.profileName) subParts.push(s.profileName);
        subParts.push(s.messageCount + " 条消息");
        if (s.updatedAt) subParts.push(formatShortTime(s.updatedAt));
        return (
          '<div class="history-item ' + (isActive ? "active" : "") + '" data-sid="' + escapeHtml(s.id) + '">' +
          '<div class="history-main">' +
          '<span class="history-title">' + escapeHtml(s.title) + "</span>" +
          '<span class="history-sub">' + escapeHtml(subParts.join(" · ")) + "</span>" +
          "</div>" +
          '<button class="history-del" data-del="' + escapeHtml(s.id) + '" title="删除会话">×</button>' +
          "</div>"
        );
      })
      .join("");
    historyListBody.innerHTML =
      '<div class="popover-header"><span>最近会话（上方可搜全部聊天内容）</span><span>' + (state.sessions || []).length + "</span></div>" +
      listHtml;

    historyListBody.querySelectorAll("[data-sid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target && e.target.closest("[data-del]")) return;
        flushDraftNow();
        vscode.postMessage({ type: "selectSession", sessionId: el.dataset.sid });
        closePopovers();
      });
    });
    historyListBody.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "deleteSession", sessionId: btn.dataset.del });
      });
    });
  }

  function formatIdleDuration(minutes) {
    if (minutes < 60) return minutes + " 分钟";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? h + " 小时 " + m + " 分钟" : h + " 小时";
  }

  function formatContextScale(tokens, msgCount) {
    if (tokens >= 10000) {
      return "约 " + Math.round(tokens / 10000) + " 万 tokens · " + msgCount + " 条消息";
    }
    return msgCount + " 条消息";
  }

  function renderCacheAlert(state) {
    if (!cacheAlertBar) return;

    if (state.isHandingOff) {
      cacheAlertBar.className = "cache-alert-bar info";
      cacheAlertBar.style.display = "flex";
      cacheAlertBar.innerHTML =
        '<div class="cache-alert-text">' +
        '<div class="cache-alert-title"><span class="streaming-star">' + ICON_STAR_SM + "</span><span>Claude 正在压缩记忆并创建新对话...</span></div>" +
        '<div class="cache-alert-desc">原对话会安全保存在历史记录中，顶部 🔍 随时可搜索回看。</div>' +
        "</div>";
      return;
    }

    // 若当前查看的是已经压缩记忆过的原对话，直接提供一键「回到新对话 →」，不再催促重复压缩
    if (state.continuedToSession && state.continuedToSession.id) {
      const target = state.continuedToSession;
      cacheAlertBar.className = "cache-alert-bar info";
      cacheAlertBar.style.display = "flex";
      cacheAlertBar.innerHTML =
        '<div class="cache-alert-text">' +
        '<div class="cache-alert-title">已压缩记忆并接续到「' + escapeHtml(target.title) + "」</div>" +
        '<div class="cache-alert-desc">你可以放心在此翻看原对话记录，随时点右侧一键回到新对话继续聊。</div>' +
        "</div>" +
        '<div class="cache-alert-actions">' +
        '<button class="cache-handoff-btn danger" id="backToContinuedBtn">回到新对话 →</button>' +
        "</div>";
      const backBtn = document.getElementById("backToContinuedBtn");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          flushDraftNow();
          vscode.postMessage({ type: "selectSession", sessionId: target.id });
        });
      }
      return;
    }

    const info = state.sessionCacheInfo || {};
    const sid = (state.activeSession && state.activeSession.id) || "";
    const msgCount = info.messageCount || 0;
    const tokens = info.contextTokens || 0;
    const lastReplyAt = info.lastReplyAt || 0;

    if (state.isRunning || msgCount < 6 || !lastReplyAt) {
      cacheAlertBar.style.display = "none";
      return;
    }

    const idleMin = Math.max(0, Math.floor((Date.now() - lastReplyAt) / 60000));
    const sizeDesc = formatContextScale(tokens, msgCount);

    let level = "";
    let title = "";
    let desc = "";
    let actionsHtml = "";

    if (idleMin >= 58 && (tokens >= 100000 || msgCount >= 20)) {
      level = "danger";
      title = "对话停了超过 1 小时，建议先压缩记忆再继续";
      desc = "本对话较长（" + msgCount + " 条记录），直接续聊会多扣不少 5 小时额度。点右侧一键压缩记忆开新对话，不丢进度又省额度。";
      actionsHtml =
        '<button class="cache-handoff-btn danger" id="cacheHandoffBtn">压缩记忆并开新对话</button>' +
        '<button class="cache-handoff-btn ghost" id="cacheNewChatBtn">开空白新对话</button>';
    } else if (idleMin >= 45 && idleMin < 58 && (tokens >= 120000 || msgCount >= 24)) {
      level = "warn";
      title = "对话较长，建议现在压缩记忆更省额度";
      desc = "本对话已有 " + msgCount + " 条记录，点右侧一键总结进度并开新对话，原记录随时可搜。";
      actionsHtml =
        '<button class="cache-handoff-btn warn" id="cacheHandoffBtn">压缩记忆并开新对话</button>';
    } else if (idleMin < 45 && (tokens >= 250000 || msgCount >= 50)) {
      level = "info";
      title = "本次对话已较长（" + msgCount + " 条记录）";
      desc = "对话越长越费额度，做完手头小目标后可一键压缩记忆开新对话，原记录随时可搜。";
      actionsHtml =
        '<button class="cache-handoff-btn info" id="cacheHandoffBtn">压缩记忆并开新对话</button>';
    }

    if (!level) {
      cacheAlertBar.style.display = "none";
      return;
    }

    const alertKey = sid + ":" + level + ":" + lastReplyAt;
    if (dismissedAlertKey === alertKey) {
      cacheAlertBar.style.display = "none";
      return;
    }

    cacheAlertBar.className = "cache-alert-bar " + level;
    cacheAlertBar.style.display = "flex";
    cacheAlertBar.innerHTML =
      '<div class="cache-alert-text">' +
      '<div class="cache-alert-title">' + escapeHtml(title) + "</div>" +
      '<div class="cache-alert-desc">' + escapeHtml(desc) + "</div>" +
      "</div>" +
      '<div class="cache-alert-actions">' +
      actionsHtml +
      '<button class="cache-dismiss-btn" id="cacheDismissBtn" title="暂时收起提示">×</button>' +
      "</div>";

    const newChatQuick = document.getElementById("cacheNewChatBtn");
    if (newChatQuick) {
      newChatQuick.addEventListener("click", () => {
        flushDraftNow();
        vscode.postMessage({ type: "newSession" });
      });
    }
    const btn = document.getElementById("cacheHandoffBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        flushDraftNow();
        vscode.postMessage({ type: "handoffSession" });
      });
    }
    const dismiss = document.getElementById("cacheDismissBtn");
    if (dismiss) {
      dismiss.addEventListener("click", () => {
        dismissedAlertKey = alertKey;
        cacheAlertBar.style.display = "none";
      });
    }
  }

  function renderPopovers(state) {
    renderQuotaPopover(state);
    renderServerPopover(state);
    renderSettingsPopover(state);
    // 1. 历史会话与跨会话全文搜索
    renderHistoryBody(state);

    // 2. 权限弹出菜单
    permPopover.innerHTML = PERM_OPTIONS.map((opt) => {
      const selected = opt.value === state.permissionMode;
      return (
        '<div class="menu-option ' + (selected ? "selected" : "") + '" data-perm="' + opt.value + '">' +
        '<div class="menu-opt-text">' +
        '<span class="menu-opt-title">' + escapeHtml(opt.title) + "</span>" +
        '<span class="menu-opt-desc">' + escapeHtml(opt.desc) + "</span>" +
        "</div>" +
        '<span class="menu-check">' + (selected ? "✓" : "") + "</span>" +
        "</div>"
      );
    }).join("");

    permPopover.querySelectorAll("[data-perm]").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({ type: "setPermissionMode", mode: el.dataset.perm });
        closePopovers();
      });
    });

    // 3. 模型 + 思考强度合并弹出菜单（随当前服务器的引擎动态切换模型列表）
    const activeModelList =
      Array.isArray(state.modelOptions) && state.modelOptions.length > 0
        ? state.modelOptions
        : MODEL_OPTIONS;
    const currentModel = state.model || "";
    const currentEffort = state.effort || "";
    const hasPresetModel = activeModelList.some((o) => o.value === currentModel);
    const displayModelOptions = hasPresetModel
      ? activeModelList
      : [
          ...activeModelList,
          {
            value: currentModel,
            short: currentModel,
            title: currentModel,
            desc: "自定义模型（来自设置）",
          },
        ];

    const modelsHtml = displayModelOptions
      .map((opt) => {
        const selected = opt.value === currentModel;
        return (
          '<div class="menu-option ' + (selected ? "selected" : "") + '" data-model="' + escapeHtml(opt.value) + '">' +
          '<div class="menu-opt-text">' +
          '<span class="menu-opt-title">' + escapeHtml(opt.title) + "</span>" +
          '<span class="menu-opt-desc">' + escapeHtml(opt.desc) + "</span>" +
          "</div>" +
          '<span class="menu-check">' + (selected ? "✓" : "") + "</span>" +
          "</div>"
        );
      })
      .join("");

    const activeEffortObj =
      EFFORT_OPTIONS.find((e) => e.value === currentEffort) || EFFORT_OPTIONS[0];
    const effortHtml =
      '<div class="popover-divider"></div>' +
      '<div class="effort-section">' +
      '<div class="effort-header"><span>思考强度 (Effort)</span><span>' + escapeHtml(activeEffortObj.desc) + "</span></div>" +
      '<div class="effort-grid">' +
      EFFORT_OPTIONS.map((opt) => {
        const selected = opt.value === currentEffort;
        return (
          '<button class="effort-chip ' + (selected ? "selected" : "") + '" data-effort="' + escapeHtml(opt.value) + '" title="' + escapeHtml(opt.desc) + '">' +
          escapeHtml(opt.label) +
          "</button>"
        );
      }).join("") +
      "</div></div>";

    modelPopover.innerHTML = modelsHtml + effortHtml;

    modelPopover.querySelectorAll("[data-model]").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({ type: "setModel", model: el.dataset.model });
      });
    });

    modelPopover.querySelectorAll("[data-effort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "setEffort", effort: btn.dataset.effort });
      });
    });
  }

  function renderTabStrip(state) {
    if (!tabStrip) return;
    const tabs = state.openTabs || [];
    if (tabs.length < 2) {
      tabStrip.style.display = "none";
      return;
    }
    const activeId = (state.activeSession && state.activeSession.id) || "";
    tabStrip.style.display = "flex";
    tabStrip.innerHTML =
      tabs
        .map((t) => {
          const isAct = t.id === activeId;
          const dotHtml = t.isRunning ? '<span class="tab-run-dot" title="后台回复中"></span>' : "";
          return (
            '<div class="chat-tab ' + (isAct ? "active" : "") + '" data-tab-sid="' + escapeHtml(t.id) + '" title="' + escapeHtml(t.title) + '">' +
            dotHtml +
            '<span class="chat-tab-title">' + escapeHtml(t.title) + "</span>" +
            '<button type="button" class="chat-tab-close" data-close-tab="' + escapeHtml(t.id) + '" title="关闭此标签（仅收起，不删历史记录）">×</button>' +
            "</div>"
          );
        })
        .join("") +
      '<button type="button" class="chat-tab-add" id="tabAddBtn" title="新开一个对话标签">+</button>';

    tabStrip.querySelectorAll("[data-tab-sid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target && e.target.closest("[data-close-tab]")) return;
        const sid = el.dataset.tabSid;
        if (sid && sid !== activeId) {
          flushDraftNow();
          vscode.postMessage({ type: "selectSession", sessionId: sid });
        }
      });
    });
    tabStrip.querySelectorAll("[data-close-tab]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sid = btn.dataset.closeTab;
        if (sid) {
          flushDraftNow();
          vscode.postMessage({ type: "closeTab", sessionId: sid });
        }
      });
    });
    const addBtn = document.getElementById("tabAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        flushDraftNow();
        vscode.postMessage({ type: "newSession" });
      });
    }
  }

  function render(state) {
    applyChatTheme(state.chatTheme || "claude");
    renderTabStrip(state);

    // 首次加载或切换会话时，还原该会话持久化保存的草稿文本（防重载窗口丢失）
    const activeSid = state.activeSession && state.activeSession.id;
    if (activeSid && activeSid !== lastLoadedSessionId) {
      lastLoadedSessionId = activeSid;
      promptInput.value = (state.activeSession && state.activeSession.draftText) || "";
      autoResize();
    }

    // 顶栏会话名 & 状态
    sessionTitleText.textContent = (state.activeSession && state.activeSession.title) || "新对话";

    const st = state.bridge.status;
    const pName = (state.activeProfile && state.activeProfile.name) || "";
    const hasMulti = (state.profiles || []).length > 1;
    statusDot.className = "dot " + st;
    if (st === "connected") {
      statusText.textContent = hasMulti && pName ? pName : "已连接";
    } else if (st === "connecting") {
      statusText.textContent = "连接中...";
    } else if (st === "error") {
      statusText.textContent = "已断开";
    } else {
      statusText.textContent = "未连接";
    }
    statusBtn.title =
      (pName ? pName + " · " : "") + (state.bridge.detail || "") + "（点击切换服务器或重连）";

    // 底部权限/模型胶囊
    const activePerm = PERM_OPTIONS.find((p) => p.value === state.permissionMode) || PERM_OPTIONS[0];
    permBtn.className = "pill-btn " + activePerm.cls;
    permBtnLabel.textContent = activePerm.short;

    const activeModelList =
      Array.isArray(state.modelOptions) && state.modelOptions.length > 0
        ? state.modelOptions
        : MODEL_OPTIONS;
    const activeModel =
      activeModelList.find((m) => m.value === (state.model || "")) ||
      (state.model ? { short: state.model } : activeModelList[0]);
    const effortSuffix = state.effort ? " · " + state.effort : "";
    modelBtnLabel.textContent = activeModel.short + effortSuffix;

    if (promptInput) {
      promptInput.placeholder =
        state.engine === "antigravity"
          ? "Ask Antigravity anything... (Enter 发送，Shift+Enter 换行，输入 / 调 Skill)"
          : "Ask Claude anything... (Enter 发送，Shift+Enter 换行，输入 / 调 Skill)";
    }

    updateSendVisual();
    renderPopovers(state);
    renderCacheAlert(state);

    const msgs = (state.activeSession && state.activeSession.messages) || [];
    const totalCount =
      typeof state.totalMessageCount === "number" ? state.totalMessageCount : msgs.length;
    if (handoffBtn) {
      handoffBtn.style.display = totalCount >= 4 ? "inline-flex" : "none";
      handoffBtn.disabled = Boolean(state.isRunning || state.isHandingOff);
    }

    // 输入框顶部：当前项目与 Git 分支徽标 + 附件芯片 + 当前活动文件一键引用
    let ctxHtml = "";
    const gb = state.gitBadge;
    if (gb && gb.workspaceName) {
      const branchPart = gb.isGitRepo && gb.branch
        ? '<span class="repo-branch-icon">' + ICON_BRANCH + "</span>" +
          '<span class="repo-pill-text">' + escapeHtml(gb.workspaceName) + " · " + escapeHtml(gb.branch) + "</span>"
        : '<span class="repo-pill-text">' + escapeHtml(gb.workspaceName) + "</span>";
      const dirtyPart = gb.isGitRepo && gb.changedCount > 0
        ? '<span class="repo-dirty-count">' + gb.changedCount + " 改动</span>"
        : "";
      const tip =
        gb.workspacePath +
        (gb.isGitRepo && gb.branch ? " (" + gb.branch + ")" : "") +
        " — 点击刷新 Git 状态";
      ctxHtml +=
        '<button class="repo-pill" id="repoPillBtn" title="' + escapeHtml(tip) + '">' +
        branchPart +
        dirtyPart +
        "</button>";
    }

    const atts = state.attachments || [];
    atts.forEach((att) => {
      ctxHtml +=
        '<span class="file-chip">' +
        '<span class="file-chip-label" data-open-file="' + escapeHtml(att.filePath) + '" data-open-line="' + (att.startLine || "") + '" title="' + escapeHtml(att.filePath) + '">' + escapeHtml(att.label) + "</span>" +
        '<button class="file-chip-x" data-rm-att="' + escapeHtml(att.id) + '" title="移除">×</button>' +
        "</span>";
    });

    const ed = state.activeEditor;
    if (ed && ed.fileName) {
      const alreadyAttached = atts.some((a) => a.filePath === ed.filePath && !ed.hasSelection);
      if (!alreadyAttached) {
        const ghostLabel = ed.hasSelection
          ? "+ 引用选区 " + ed.fileName + ":" + ed.selectionRange
          : "+ " + ed.fileName;
        ctxHtml +=
          '<button class="context-ghost-btn" id="quickAddEditorBtn" title="点击快速附加到本次对话"><span>' +
          escapeHtml(ghostLabel) +
          "</span></button>";
      }
    }

    composerContext.innerHTML = ctxHtml;
    composerContext.style.display = ctxHtml ? "flex" : "none";

    const repoPillBtn = document.getElementById("repoPillBtn");
    if (repoPillBtn) {
      repoPillBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "refreshGit" });
      });
    }
    const quickAddBtn = document.getElementById("quickAddEditorBtn");
    if (quickAddBtn) {
      quickAddBtn.addEventListener("click", () => {
        vscode.postMessage({ type: ed && ed.hasSelection ? "addSelection" : "addCurrentFile" });
      });
    }
    composerContext.querySelectorAll("[data-rm-att]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "removeAttachment", id: btn.dataset.rmAtt });
      });
    });
    composerContext.querySelectorAll("[data-open-file]").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({
          type: "openFile",
          filePath: el.dataset.openFile,
          startLine: el.dataset.openLine ? Number(el.dataset.openLine) : undefined,
        });
      });
    });

    // 消息区：单条缓存 + 流式局部更新 + 微信式上滑自动加载定位锚定
    const shouldStickBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;

    const handoff = state.activeSession && state.activeSession.handoff;
    const renderHandoffCard = (expanded) => {
      if (!handoff) return "";
      return (
        '<details class="handoff-card"' + (expanded ? " open" : "") + ">" +
        '<summary class="handoff-card-head">' +
        '<span class="handoff-card-title">' + ICON_STAR_SM + " 已压缩记忆，接续「" + escapeHtml(handoff.sourceSessionTitle) + "」</span>" +
        '<span class="handoff-card-right">' +
        '<span class="handoff-mode-tag">记忆摘要</span>' +
        '<button type="button" class="handoff-source-btn" data-jump-session="' + escapeHtml(handoff.sourceSessionId) + '" title="切回上一轮完整原对话">查看原对话 →</button>' +
        "</span>" +
        "</summary>" +
        '<div class="handoff-card-body md">' + renderMarkdown(handoff.summary) + "</div>" +
        '<div class="handoff-card-foot">直接发消息即可，第一句会自动带上这份记忆摘要；原对话已保存，点顶部 🔍 随时可搜。</div>' +
        "</details>"
      );
    };

    const curSid = (state.activeSession && state.activeSession.id) || "";
    const startIdx = typeof state.loadedStartIndex === "number" ? state.loadedStartIndex : 0;
    const hasMoreOlder = Boolean(state.hasMoreOlder);
    const isSessionSwitchOrInit = curSid !== lastRenderedSessionId;

    if (isSessionSwitchOrInit) {
      isLoadingOlder = false;
      scrollAnchor = null;
      lastRenderedListKey = "";
      suppressAutoLoadUntil = Date.now() + 500;
    }

    if (msgs.length === 0) {
      lastRenderedSessionId = curSid;
      lastRenderedStartIndex = 0;
      lastRenderedCount = 0;
      lastRenderedListKey = "";
      isLoadingOlder = false;
      scrollAnchor = null;

      if (handoff) {
        messagesEl.innerHTML =
          '<div class="handoff-empty-wrap">' +
          renderHandoffCard(true) +
          "</div>";
        bindMessageInteractions(messagesEl);
        return;
      }

      const wsName = state.workspacePath ? state.workspacePath.split("/").pop() : "未打开工作区";
      let wsInner = "<span>" + escapeHtml(wsName) + "</span>";
      if (gb && gb.isGitRepo && gb.branch) {
        wsInner +=
          '<span class="ws-branch-sep">·</span>' +
          '<span class="repo-branch-icon">' + ICON_BRANCH + "</span>" +
          "<span>" + escapeHtml(gb.branch) + "</span>";
        if (gb.changedCount > 0) {
          wsInner += '<span class="repo-dirty-count">(' + gb.changedCount + " 个改动)</span>";
        }
      }
      messagesEl.innerHTML =
        '<div class="welcome">' +
        '<div class="welcome-logo">' + ICON_STAR + "</div>" +
        "<h2>ClaudeBridge · 渡桥</h2>" +
        '<div class="welcome-sub">代码留在本地，AI 推理通过加密专线运行于远程服务器</div>' +
        '<div class="ws-badge"><span class="dot ' + escapeHtml(st) + '"></span>' + wsInner + "</div>" +
        '<div class="prompts-list">' +
        '<button class="prompt-card" data-quick="先帮我概览当前工作区的目录结构和核心模块职责。"><span class="prompt-card-icon">' + ICON_STAR_SM + "</span><span>概览当前项目结构与核心模块</span></button>" +
        '<button class="prompt-card" data-quick="帮我梳理当前打开文件的核心流程与潜在风险点。"><span class="prompt-card-icon">' + ICON_STAR_SM + "</span><span>梳理当前打开文件的核心逻辑</span></button>" +
        '<button class="prompt-card" data-quick="帮我评审下当前 git 的所有未提交改动，重点指出潜在 bug 和风险。"><span class="prompt-card-icon">' + ICON_STAR_SM + "</span><span>评审当前 Git 改动并做 Code Review</span></button>" +
        "</div></div>";

      messagesEl.querySelectorAll("[data-quick]").forEach((btn) => {
        btn.addEventListener("click", () => {
          promptInput.value = btn.dataset.quick || "";
          triggerSend();
        });
      });
      return;
    }

    const streamingId = state.isRunning
      ? state.streamingMessageId || msgs[msgs.length - 1].id
      : null;

    // 1. 流式输出快速路径：同一会话、同一消息列表，仅局部更新正在生成的那 1 条 DOM，彻底避免重画历史
    const sameWindow =
      curSid === lastRenderedSessionId &&
      startIdx === lastRenderedStartIndex &&
      msgs.length === lastRenderedCount;

    if (sameWindow && streamingId && !pendingJumpMessageId) {
      const streamingMsg = msgs.find((m) => m.id === streamingId);
      const existingNode = messagesEl.querySelector(
        '[data-msg-id="' + streamingId.replace(/"/g, "") + '"]'
      );
      if (streamingMsg && existingNode) {
        const tmp = document.createElement("div");
        tmp.innerHTML = renderMessage(streamingMsg, true, state.workspacePath, true);
        const freshNode = tmp.firstElementChild;
        if (freshNode) {
          existingNode.replaceWith(freshNode);
          bindMessageInteractions(freshNode);
          if (shouldStickBottom) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          return;
        }
      }
    }

    // 2. 构建列表指纹：后台心跳/Git 刷新导致内容完全无变化时直接跳过整棵 DOM 重建
    const lastMsg = msgs[msgs.length - 1];
    const listKey = [
      curSid,
      startIdx,
      msgs.length,
      state.isRunning ? "1" : "0",
      streamingId || "",
      handoff ? handoff.createdAt : "",
      lastMsg.id,
      (lastMsg.text || "").length,
      (lastMsg.thinking || "").length,
      (lastMsg.tools || []).length,
      lastMsg.meta ? JSON.stringify(lastMsg.meta) : "",
    ].join("|");

    if (listKey === lastRenderedListKey && !pendingJumpMessageId) {
      return;
    }

    const prependedOlder =
      curSid === lastRenderedSessionId && startIdx < lastRenderedStartIndex;
    const prevHeightBeforeRender = scrollAnchor
      ? scrollAnchor.prevHeight
      : messagesEl.scrollHeight;
    const prevTopBeforeRender = scrollAnchor
      ? scrollAnchor.prevTop
      : messagesEl.scrollTop;

    const olderSentinelHtml = hasMoreOlder
      ? '<div class="older-sentinel">向上滑动自动加载更早记录</div>'
      : "";

    messagesEl.innerHTML =
      olderSentinelHtml +
      renderHandoffCard(false) +
      msgs
        .map((m) => {
          const isStreamingThis = Boolean(streamingId && m.id === streamingId);
          return renderMessageCached(m, isStreamingThis, state.workspacePath, state.isRunning);
        })
        .join("");

    bindMessageInteractions(messagesEl);

    lastRenderedSessionId = curSid;
    lastRenderedStartIndex = startIdx;
    lastRenderedCount = msgs.length;
    lastRenderedListKey = listKey;
    isLoadingOlder = false;
    scrollAnchor = null;

    if (pendingJumpMessageId) {
      const targetId = pendingJumpMessageId;
      pendingJumpMessageId = null;
      suppressAutoLoadUntil = Date.now() + 500;
      if (!jumpToMessageById(targetId) && (isSessionSwitchOrInit || shouldStickBottom)) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else if (prependedOlder) {
      // 上滑加载更早消息后，精确锚定原来的阅读位置，不跳屏
      const delta = messagesEl.scrollHeight - prevHeightBeforeRender;
      messagesEl.scrollTop = Math.max(0, prevTopBeforeRender + delta);
    } else if (isSessionSwitchOrInit || shouldStickBottom) {
      // 首次打开或切换会话时，确保等浏览器布局完成后稳定停留在底部最新消息
      suppressAutoLoadUntil = Date.now() + 500;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        requestAnimationFrame(() => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
      });
    }
  }

  function bindMessageInteractions(root) {
    root.querySelectorAll("[data-jump-session]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        flushDraftNow();
        vscode.postMessage({ type: "selectSession", sessionId: btn.dataset.jumpSession });
      });
    });

    root.querySelectorAll("[data-retry-msg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (currentState && currentState.isRunning) return;
        const msgId = btn.dataset.retryMsg;
        if (msgId) {
          vscode.postMessage({ type: "retryMessage", messageId: msgId });
        }
      });
    });

    root.querySelectorAll("[data-refresh-conn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "正在刷新连接...";
        vscode.postMessage({ type: "connect", force: true });
      });
    });

    root.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = decodeURIComponent(btn.dataset.copy || "");
        vscode.postMessage({ type: "copyText", text });
        if (btn.classList.contains("msg-copy-btn")) {
          btn.classList.add("copied");
          btn.innerHTML = ICON_CHECK + "<span>已复制</span>";
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.innerHTML = ICON_COPY + "<span>复制</span>";
          }, 1500);
        } else {
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1200);
        }
      });
    });

    root.querySelectorAll("[data-open-file]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        vscode.postMessage({
          type: "openFile",
          filePath: el.dataset.openFile,
          startLine: el.dataset.openLine ? Number(el.dataset.openLine) : undefined,
          endLine: el.dataset.openEndLine ? Number(el.dataset.openEndLine) : undefined,
        });
      });
    });
  }

  function renderMessageCached(m, isStreamingThis, workspacePath, anyRunning) {
    if (isStreamingThis) {
      return renderMessage(m, true, workspacePath, anyRunning);
    }
    const isErr = Boolean(
      (m.meta && m.meta.isError) ||
      /^执行失败：|^启动远程 SSH 失败：/.test((m.text || "").trim())
    );
    const sig =
      (m.text || "").length +
      "|" +
      (m.thinking || "").length +
      "|" +
      (m.tools ? m.tools.length : 0) +
      "|" +
      (m.meta ? JSON.stringify(m.meta) : "") +
      "|" +
      (isErr && anyRunning ? "1" : "0");
    const cached = renderedMsgCache.get(m.id);
    if (cached && cached.sig === sig) {
      return cached.html;
    }
    const html = renderMessage(m, false, workspacePath, anyRunning);
    renderedMsgCache.set(m.id, { sig, html });
    if (renderedMsgCache.size > 400) {
      const oldestKey = renderedMsgCache.keys().next().value;
      if (oldestKey) renderedMsgCache.delete(oldestKey);
    }
    return html;
  }

  function renderMessage(m, isStreamingThis, workspacePath, anyRunning) {
    if (m.role === "user") {
      let attHtml = "";
      if (m.attachments && m.attachments.length > 0) {
        attHtml =
          '<div class="att-row">' +
          m.attachments
            .map(
              (a) =>
                '<span class="file-chip"><span class="file-chip-label" data-open-file="' +
                escapeHtml(a.filePath) +
                '" data-open-line="' +
                (a.startLine || "") +
                '">' +
                escapeHtml(a.label) +
                "</span></span>"
            )
            .join("") +
          "</div>";
      }
      const timeHtml = m.timestamp
        ? '<div class="msg-user-time">' + escapeHtml(formatShortTime(m.timestamp)) + "</div>"
        : "";
      return (
        '<div class="msg-user-card" data-msg-id="' + escapeHtml(m.id) + '">' +
        attHtml +
        '<div class="msg-user-text">' + escapeHtml(m.text) + "</div>" +
        timeHtml +
        "</div>"
      );
    }

    let html = '<div class="msg-assistant" data-msg-id="' + escapeHtml(m.id) + '">';

    if (m.thinking && m.thinking.trim()) {
      html +=
        '<details class="thinking-block"><summary>' +
        '<span style="color:var(--claude-orange)">✦</span><span>Thinking</span>' +
        "</summary>" +
        '<div class="thinking-body">' + escapeHtml(m.thinking) + "</div></details>";
    }

    if (m.tools && m.tools.length > 0) {
      html += '<div class="tools-stack">';
      m.tools.forEach((t) => {
        const verb = formatToolVerb(t.name);
        const target = t.filePath ? shortPath(t.filePath, workspacePath) : t.inputSummary;
        const fileBtn = t.filePath
          ? '<span class="tool-open-link" data-open-file="' + escapeHtml(t.filePath) + '">↗ 在编辑器中打开 ' + escapeHtml(shortPath(t.filePath, workspacePath)) + "</span>\n"
          : "";
        const outSection = t.output ? "\n--- Output ---\n" + escapeHtml(t.output) : "";
        html +=
          '<details class="tool-row">' +
          "<summary>" +
          '<span class="tool-dot ' + escapeHtml(t.status) + '"></span>' +
          '<span class="tool-verb">' + escapeHtml(verb) + "</span>" +
          '<span class="tool-target">' + escapeHtml(target) + "</span>" +
          "</summary>" +
          '<div class="tool-detail">' + fileBtn + escapeHtml(t.inputRaw) + outSection + "</div>" +
          "</details>";
      });
      html += "</div>";
    }

    if (m.text && m.text.trim()) {
      html += '<div class="md">' + renderMarkdown(m.text) + "</div>";
    }

    if (isStreamingThis) {
      html +=
        '<div class="streaming-indicator">' +
        '<span class="streaming-star">' + ICON_STAR_SM + "</span>" +
        "<span>Claude 正在处理...</span></div>";
    } else {
      const parts = [];
      if (m.meta) {
        if (m.meta.model) parts.push(m.meta.model);
        if (typeof m.meta.durationMs === "number") parts.push((m.meta.durationMs / 1000).toFixed(1) + "s");
        if (typeof m.meta.costUsd === "number") parts.push("$" + m.meta.costUsd.toFixed(4));
      }
      const trimmedText = (m.text || "").trim();
      const hasText = Boolean(trimmedText);
      const isFailed = Boolean(
        (m.meta && m.meta.isError) ||
        /^执行失败：|^启动远程 SSH 失败：/.test(trimmedText)
      );
      const failCount = (m.meta && typeof m.meta.failCount === "number") ? m.meta.failCount : (isFailed ? 1 : 0);

      if (isFailed && failCount >= 3) {
        html +=
          '<div class="retry-warn-bar">' +
          '<span class="retry-warn-text">已连续失败 ' + failCount + " 次，可能是代理或网络波动导致连接异常，建议先刷新连接状况再重试。</span>" +
          '<button class="retry-reconnect-btn" data-refresh-conn="1" title="重新建立本地 DevSpace 与 SSH 隧道">' +
          ICON_REFRESH + "<span>刷新连接状况</span></button>" +
          "</div>";
      }

      if (parts.length > 0 || hasText || isFailed) {
        const retryLabel = failCount >= 2 ? "重试 (已失败 " + failCount + " 次)" : "重试";
        const retryBtnHtml = isFailed
          ? '<button class="msg-retry-btn" data-retry-msg="' + escapeHtml(m.id) + '" title="原地重试本条提问"' +
            (anyRunning ? " disabled" : "") + ">" + ICON_REFRESH + "<span>" + escapeHtml(retryLabel) + "</span></button>"
          : "";
        const copyBtnHtml = hasText
          ? '<button class="msg-copy-btn" data-copy="' + encodeURIComponent(m.text) + '" title="复制整条 Markdown 内容">' + ICON_COPY + "<span>复制</span></button>"
          : "";
        html +=
          '<div class="msg-footer">' +
          '<span class="msg-meta-text">' + escapeHtml(parts.join(" · ")) + "</span>" +
          '<div class="msg-footer-actions">' + retryBtnHtml + copyBtnHtml + "</div>" +
          "</div>";
      }
    }

    html += "</div>";
    return html;
  }

  vscode.postMessage({ type: "ready" });
})();
