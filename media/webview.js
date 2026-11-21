import { Marked, Renderer } from "marked";

(function () {
  const vscode = acquireVsCodeApi();
  let currentState = null;
  let openPopover = null; // "history" | "perm" | "model" | null

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 配置支持 GFM 表格、有序列表、任务列表且禁用原始 HTML 注入的安全 Markdown 渲染器
  const mdRenderer = new Renderer();

  mdRenderer.html = function (token) {
    return escapeHtml(token.text ?? token.raw ?? "");
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
    const safe = /^(https?:|mailto:)/i.test(href);
    const label = this.parser.parseInline(token.tokens);
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
  const statusBtn = document.getElementById("statusBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const historyPopover = document.getElementById("historyPopover");
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
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.4 9.2L22 12L14.4 14.8L12 22L9.6 14.8L2 12L9.6 9.2L12 2Z"/></svg>';
  const ICON_STAR_SM =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.4 9.2L22 12L14.4 14.8L12 22L9.6 14.8L2 12L9.6 9.2L12 2Z"/></svg>';
  const ICON_BRANCH =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  const ICON_COPY =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function togglePopover(name) {
    openPopover = openPopover === name ? null : name;
    historyPopover.classList.toggle("open", openPopover === "history");
    permPopover.classList.toggle("open", openPopover === "perm");
    modelPopover.classList.toggle("open", openPopover === "model");
  }

  function closePopovers() {
    if (!openPopover) return;
    openPopover = null;
    historyPopover.classList.remove("open");
    permPopover.classList.remove("open");
    modelPopover.classList.remove("open");
  }

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (
      target.closest(".popover") ||
      target.closest("#sessionTrigger") ||
      target.closest("#permBtn") ||
      target.closest("#modelBtn")
    ) {
      return;
    }
    closePopovers();
  });

  sessionTrigger.addEventListener("click", () => togglePopover("history"));
  permBtn.addEventListener("click", () => togglePopover("perm"));
  modelBtn.addEventListener("click", () => togglePopover("model"));

  statusBtn.addEventListener("click", () => {
    const isConnected = currentState && currentState.bridge && currentState.bridge.status === "connected";
    vscode.postMessage({ type: "connect", force: Boolean(isConnected) });
  });

  document.getElementById("newChatBtn").addEventListener("click", () => {
    closePopovers();
    vscode.postMessage({ type: "newSession" });
  });

  document.getElementById("terminalBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openTerminal" });
  });

  document.getElementById("settingsBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
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
    promptInput.value = "";
    autoResize();
    updateSendVisual();
    vscode.postMessage({ type: "send", text });
  }

  sendBtn.addEventListener("click", triggerSend);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      triggerSend();
    }
  });
  promptInput.addEventListener("input", () => {
    autoResize();
    updateSendVisual();
  });

  function autoResize() {
    promptInput.style.height = "44px";
    promptInput.style.height = Math.min(180, promptInput.scrollHeight) + "px";
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state") {
      currentState = msg.payload;
      render(currentState);
    }
  });

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

  function renderPopovers(state) {
    // 1. 历史会话
    const listHtml = (state.sessions || [])
      .map((s) => {
        const isActive = s.id === state.activeSession.id;
        return (
          '<div class="history-item ' + (isActive ? "active" : "") + '" data-sid="' + escapeHtml(s.id) + '">' +
          '<div class="history-main">' +
          '<span class="history-title">' + escapeHtml(s.title) + "</span>" +
          '<span class="history-sub">' + s.messageCount + " 条消息</span>" +
          "</div>" +
          '<button class="history-del" data-del="' + escapeHtml(s.id) + '" title="删除会话">×</button>' +
          "</div>"
        );
      })
      .join("");
    historyPopover.innerHTML =
      '<div class="popover-header"><span>最近会话</span><span>' + (state.sessions || []).length + "</span></div>" +
      listHtml;

    historyPopover.querySelectorAll("[data-sid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target && e.target.closest("[data-del]")) return;
        vscode.postMessage({ type: "selectSession", sessionId: el.dataset.sid });
        closePopovers();
      });
    });
    historyPopover.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "deleteSession", sessionId: btn.dataset.del });
      });
    });

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

    // 3. 模型 + 思考强度合并弹出菜单
    const currentModel = state.model || "";
    const currentEffort = state.effort || "";
    const hasPresetModel = MODEL_OPTIONS.some((o) => o.value === currentModel);
    const displayModelOptions = hasPresetModel
      ? MODEL_OPTIONS
      : [
          ...MODEL_OPTIONS,
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

  function render(state) {
    // 顶栏会话名 & 状态
    sessionTitleText.textContent = (state.activeSession && state.activeSession.title) || "新对话";

    const st = state.bridge.status;
    statusDot.className = "dot " + st;
    if (st === "connected") {
      statusText.textContent = "EC2 已连接";
    } else if (st === "connecting") {
      statusText.textContent = "连接中...";
    } else if (st === "error") {
      statusText.textContent = "已断开";
    } else {
      statusText.textContent = "未连接";
    }
    statusBtn.title = (state.bridge.detail || "") + "（点击重连）";

    // 底部权限/模型胶囊
    const activePerm = PERM_OPTIONS.find((p) => p.value === state.permissionMode) || PERM_OPTIONS[0];
    permBtn.className = "pill-btn " + activePerm.cls;
    permBtnLabel.textContent = activePerm.short;

    const activeModel =
      MODEL_OPTIONS.find((m) => m.value === (state.model || "")) ||
      (state.model ? { short: state.model } : MODEL_OPTIONS[0]);
    const effortSuffix = state.effort ? " · " + state.effort : "";
    modelBtnLabel.textContent = activeModel.short + effortSuffix;

    updateSendVisual();
    renderPopovers(state);

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

    // 消息区
    const shouldStickBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;

    const msgs = (state.activeSession && state.activeSession.messages) || [];
    if (msgs.length === 0) {
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
        "<h2>Claude Code · EC2</h2>" +
        '<div class="welcome-sub">远程大脑运行于 AWS EC2，通过加密专线直接读写本地代码</div>' +
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

    messagesEl.innerHTML = msgs
      .map((m, idx) => renderMessage(m, idx === msgs.length - 1 && state.isRunning, state.workspacePath))
      .join("");

    messagesEl.querySelectorAll("[data-copy]").forEach((btn) => {
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

    messagesEl.querySelectorAll("[data-open-file]").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({
          type: "openFile",
          filePath: el.dataset.openFile,
          startLine: el.dataset.openLine ? Number(el.dataset.openLine) : undefined,
        });
      });
    });

    if (shouldStickBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderMessage(m, isStreamingThis, workspacePath) {
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
      return (
        '<div class="msg-user-card">' +
        attHtml +
        '<div class="msg-user-text">' + escapeHtml(m.text) + "</div>" +
        "</div>"
      );
    }

    let html = '<div class="msg-assistant">';

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
      const hasText = Boolean(m.text && m.text.trim());
      if (parts.length > 0 || hasText) {
        const copyBtnHtml = hasText
          ? '<button class="msg-copy-btn" data-copy="' + encodeURIComponent(m.text) + '" title="复制整条 Markdown 内容">' + ICON_COPY + "<span>复制</span></button>"
          : "";
        html +=
          '<div class="msg-footer">' +
          '<span class="msg-meta-text">' + escapeHtml(parts.join(" · ")) + "</span>" +
          copyBtnHtml +
          "</div>";
      }
    }

    html += "</div>";
    return html;
  }

  vscode.postMessage({ type: "ready" });
})();
