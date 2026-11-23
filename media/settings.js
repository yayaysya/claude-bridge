(function () {
  const vscode = acquireVsCodeApi();
  let currentProxyMode = "auto";
  let rulePaths = ["~/.claude/CLAUDE.md"];
  let envProxyStr = "";

  const $ = (id) => document.getElementById(id);

  const toastBar = $("toastBar");
  const bridgeBadge = $("bridgeBadge");
  const testResultBox = $("testResultBox");
  const testConnBtn = $("testConnBtn");
  const pullMemoriesBtn = $("pullMemoriesBtn");
  const memoriesList = $("memoriesList");
  const rulePathsList = $("rulePathsList");
  const proxyAutoHint = $("proxyAutoHint");
  const proxyCustomWrap = $("proxyCustomWrap");
  const sshProxyCustom = $("sshProxyCustom");

  let toastTimer = null;
  function showToast(ok, message) {
    toastBar.textContent = message;
    toastBar.className = "toast-bar show " + (ok ? "ok" : "err");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBar.classList.remove("show");
    }, 5000);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setProxyMode(mode, customVal) {
    currentProxyMode = mode;
    document.querySelectorAll("[data-proxy-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.proxyMode === mode);
    });
    proxyCustomWrap.classList.toggle("show", mode === "custom");
    if (mode === "custom" && typeof customVal === "string") {
      sshProxyCustom.value = customVal;
    }
    if (mode === "auto") {
      proxyAutoHint.textContent = envProxyStr
        ? "当前检测到环境代理：" + envProxyStr + "（端口存活时自动走代理，未开启时自动直连）"
        : "当前未检测到环境代理，将自动直连；开启系统代理后会自动跟随。";
    } else if (mode === "off") {
      proxyAutoHint.textContent = "始终直连远程服务器，忽略环境变量中的代理设置。";
    } else {
      proxyAutoHint.textContent = "支持 HTTP CONNECT（http://host:port）和 SOCKS5（socks5://host:port）。";
    }
  }

  document.querySelectorAll("[data-proxy-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setProxyMode(btn.dataset.proxyMode);
    });
  });

  function renderRulePaths() {
    if (!rulePaths.length) {
      rulePaths = ["~/.claude/CLAUDE.md"];
    }
    rulePathsList.innerHTML = rulePaths
      .map(
        (p, idx) =>
          '<div class="path-item">' +
          '<input type="text" data-rule-idx="' + idx + '" value="' + escapeHtml(p) + '" />' +
          '<button type="button" class="btn secondary small" data-del-rule="' + idx + '">移除</button>' +
          "</div>"
      )
      .join("");

    rulePathsList.querySelectorAll("[data-rule-idx]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = Number(inp.dataset.ruleIdx);
        rulePaths[i] = inp.value;
      });
    });

    rulePathsList.querySelectorAll("[data-del-rule]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.delRule);
        rulePaths.splice(i, 1);
        renderRulePaths();
      });
    });
  }

  function renderMemories(memories) {
    if (!memories || memories.length === 0) {
      memoriesList.innerHTML =
        '<div class="memory-empty">暂未拉取远程记忆。点击右上角「拉取并备份远程记忆」即可查看远程 Claude 记住的所有习惯。</div>';
      return;
    }

    memoriesList.innerHTML = memories
      .map((m) => {
        const dateStr = m.modifiedAt
          ? new Date(m.modifiedAt).toLocaleString()
          : "";
        const mergeBtn =
          m.fileName !== "MEMORY.md"
            ? '<button type="button" class="btn secondary small" data-merge-mem="' + escapeHtml(m.id) + '" title="把这条习惯追加进你的本地 CLAUDE.md">合并到本地</button>'
            : "";
        return (
          '<div class="memory-item">' +
          '<div class="memory-info">' +
          '<div class="memory-title">' + escapeHtml(m.title) + "</div>" +
          '<div class="memory-preview">' + escapeHtml(m.preview || m.fileName) + "</div>" +
          '<div class="memory-meta">' + escapeHtml(m.fileName + (dateStr ? " · " + dateStr : "")) + "</div>" +
          "</div>" +
          '<div class="memory-btns">' +
          '<button type="button" class="btn secondary small" data-open-mem="' + escapeHtml(m.localBackupPath) + '">查看</button>' +
          mergeBtn +
          "</div></div>"
        );
      })
      .join("");

    memoriesList.querySelectorAll("[data-open-mem]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({
          type: "openMemoryFile",
          localBackupPath: btn.dataset.openMem,
        });
      });
    });

    memoriesList.querySelectorAll("[data-merge-mem]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({
          type: "mergeMemory",
          id: btn.dataset.mergeMem,
        });
      });
    });
  }

  function collectFormConfig() {
    let sshProxy = "auto";
    if (currentProxyMode === "off") {
      sshProxy = "off";
    } else if (currentProxyMode === "custom") {
      sshProxy = sshProxyCustom.value.trim() || "auto";
    }

    return {
      sshHost: $("sshHost").value.trim(),
      sshUser: $("sshUser").value.trim() || "ubuntu",
      sshPort: Number($("sshPort").value) || 22,
      sshKeyPath: $("sshKeyPath").value.trim(),
      sshProxy,
      localPort: Number($("localPort").value) || 7676,
      remotePort: Number($("remotePort").value) || 7676,
      devspacePath: $("devspacePath").value.trim(),
      remoteClaudePath: $("remoteClaudePath").value.trim() || "claude",
      permissionMode: $("permissionMode").value,
      model: $("model").value.trim(),
      effort: $("effort").value,
      autoConnect: $("autoConnect").checked,
      autoReconnect: $("autoReconnect").checked,
      keepRunningOnClose: $("keepRunningOnClose").checked,
      autoAttachWorkspaceContext: $("autoAttachWorkspaceContext").checked,
      syncLocalRules: $("syncLocalRules").checked,
      localClaudeMdPaths: rulePaths.map((p) => p.trim()).filter(Boolean),
    };
  }

  $("saveBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "save", config: collectFormConfig(), reconnect: false });
  });

  $("saveReconnectBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "save", config: collectFormConfig(), reconnect: true });
  });

  $("pickKeyBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "pickKeyFile" });
  });

  $("addRulePathBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "pickRuleFile" });
  });

  $("openLocalRuleBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openLocalRules" });
  });

  $("syncRulesNowBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "syncRules" });
  });

  $("pullMemoriesBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "pullMemories" });
  });

  $("testConnBtn").addEventListener("click", () => {
    testConnBtn.disabled = true;
    testResultBox.className = "test-result";
    testResultBox.textContent = "正在测试 SSH 连通性与远程 Claude 状态...";
    vscode.postMessage({ type: "testConnection", config: collectFormConfig() });
  });

  $("openLogBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openLogFile" });
  });

  $("openRawSettingsBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "openRawSettings" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === "state") {
      const p = msg.payload;
      const cfg = p.config;
      envProxyStr = p.envProxy || "";

      // 状态徽标
      const st = p.bridge?.status || "disconnected";
      const label =
        st === "connected" ? "已连接" : st === "connecting" ? "连接中..." : st === "error" ? "已断开" : "未连接";
      bridgeBadge.innerHTML = '<span class="dot ' + escapeHtml(st) + '"></span><span>' + label + "</span>";
      bridgeBadge.title = p.bridge?.detail || "";

      // 填充表单
      $("sshHost").value = cfg.sshHost || "";
      $("sshUser").value = cfg.sshUser || "ubuntu";
      $("sshPort").value = cfg.sshPort || 22;
      $("sshKeyPath").value = cfg.sshKeyPath || "";
      $("localPort").value = cfg.localPort || 7676;
      $("remotePort").value = cfg.remotePort || 7676;
      $("devspacePath").value = cfg.devspacePath || "";
      $("remoteClaudePath").value = cfg.remoteClaudePath || "claude";
      $("permissionMode").value = cfg.permissionMode || "bypassPermissions";
      $("model").value = cfg.model || "";
      $("effort").value = cfg.effort || "";
      $("autoConnect").checked = Boolean(cfg.autoConnect);
      $("autoReconnect").checked = Boolean(cfg.autoReconnect);
      $("keepRunningOnClose").checked = Boolean(cfg.keepRunningOnClose);
      $("autoAttachWorkspaceContext").checked = Boolean(cfg.autoAttachWorkspaceContext);
      $("syncLocalRules").checked = Boolean(cfg.syncLocalRules);

      const proxyRaw = (cfg.sshProxy || "auto").trim();
      const lower = proxyRaw.toLowerCase();
      if (lower === "auto" || !proxyRaw) {
        setProxyMode("auto");
      } else if (lower === "off" || lower === "none" || lower === "direct") {
        setProxyMode("off");
      } else {
        setProxyMode("custom", proxyRaw);
      }

      rulePaths = Array.isArray(cfg.localClaudeMdPaths) && cfg.localClaudeMdPaths.length > 0
        ? [...cfg.localClaudeMdPaths]
        : ["~/.claude/CLAUDE.md"];
      renderRulePaths();
      renderMemories(p.memories || []);

      if (p.focusSection) {
        const targetEl = document.getElementById("section-" + p.focusSection);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      return;
    }

    if (msg.type === "pickedKeyFile") {
      $("sshKeyPath").value = msg.path || "";
      return;
    }

    if (msg.type === "pickedRuleFile" && msg.path) {
      if (!rulePaths.includes(msg.path)) {
        rulePaths.push(msg.path);
        renderRulePaths();
      }
      return;
    }

    if (msg.type === "testResult") {
      testConnBtn.disabled = false;
      testResultBox.className = "test-result " + (msg.ok ? "ok" : "err");
      testResultBox.textContent = msg.summary || "";
      return;
    }

    if (msg.type === "memoriesLoading") {
      pullMemoriesBtn.disabled = Boolean(msg.loading);
      pullMemoriesBtn.textContent = msg.loading ? "正在拉取..." : "拉取并备份远程记忆";
      return;
    }

    if (msg.type === "toast") {
      showToast(Boolean(msg.ok), msg.message || "");
    }
  });

  vscode.postMessage({ type: "ready" });
})();
