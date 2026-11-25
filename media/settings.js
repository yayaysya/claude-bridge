(function () {
  const vscode = acquireVsCodeApi();
  let currentProxyMode = "auto";
  let rulePaths = ["~/.claude/CLAUDE.md"];
  let envProxyStr = "";
  let cachedOwnerToken = "";
  let ownerPwVisible = false;
  let activeProfileId = "default";
  let wizardTargetProfileId = "default";
  let totalProfiles = 1;
  let lastSyncedWizardTargetKey = "";
  let cachedActiveProfile = null;
  let cachedWizardTargetProfile = null;
  const wizardStateByProfile = Object.create(null);

  function getWizardStore(pid) {
    const key = pid || "default";
    if (!wizardStateByProfile[key]) {
      wizardStateByProfile[key] = {
        pwHost: "",
        pwPort: "",
        pwUser: "root",
        pwCreateNonRoot: true,
        pwNewUserName: "claude",
        pwExpanded: false,
        passwordlessLog: "",
        vpsLog: "",
        verifyResult: null,
        timezone: "America/New_York",
        geometry: "1366x768",
        withDesktop: true,
      };
    }
    return wizardStateByProfile[key];
  }

  function snapshotWizardDomToStore(pid) {
    if (!pid) return;
    const st = getWizardStore(pid);
    st.pwHost = $("pwHost").value;
    st.pwPort = $("pwPort").value;
    st.pwUser = $("pwUser").value;
    st.pwCreateNonRoot = $("pwCreateNonRoot").checked;
    st.pwNewUserName = $("pwNewUserName").value;
    st.pwExpanded = $("passwordlessBox").open;
    st.timezone = $("wizTimezone").value;
    st.geometry = $("wizGeometry").value;
    st.withDesktop = $("wizWithDesktop").checked;
  }

  function renderWizardVerifyResult(r) {
    const cl = $("wizVerifyChecklist");
    const sm = $("wizVerifySummary");
    if (!r) {
      cl.innerHTML = "";
      sm.textContent = "";
      return;
    }
    const pill = (ok, label) =>
      '<span class="check-pill ' + (ok ? "ok" : "warn") + '">' + (ok ? "✓ " : "✗ ") + escapeHtml(label) + "</span>";
    cl.innerHTML =
      pill(r.sshOk, "SSH 连通") +
      pill(r.claudeInstalled, r.claudeInstalled ? "Claude " + r.claudeVersion : "Claude 未安装") +
      pill(r.claudeLoggedIn, r.claudeLoggedIn ? "Claude 账号已登录" : "Claude 未登录") +
      pill(r.devspaceMcpConnected, r.devspaceMcpConnected ? "DevSpace MCP 已授权" : "DevSpace 未授权");
    sm.textContent = r.summary || "";
  }

  function restoreWizardDomFromStore(profile) {
    if (!profile) return;
    const st = getWizardStore(profile.id);
    $("pwHost").value = st.pwHost || profile.sshHost || "";
    $("pwPort").value = st.pwPort || String(profile.sshPort || 22);
    $("pwUser").value = st.pwUser || "root";
    $("pwPassword").value = "";
    $("pwCreateNonRoot").checked = Boolean(st.pwCreateNonRoot);
    $("pwNewUserName").value = st.pwNewUserName || "claude";
    $("passwordlessBox").open = Boolean(st.pwExpanded);
    $("wizTimezone").value = st.timezone || "America/New_York";
    $("wizGeometry").value = st.geometry || "1366x768";
    $("wizWithDesktop").checked = Boolean(st.withDesktop);

    const pwLogEl = $("wizPasswordlessLog");
    pwLogEl.textContent = st.passwordlessLog || "";
    pwLogEl.classList.toggle("show", Boolean(st.passwordlessLog));

    const vpsLogEl = $("wizVpsLog");
    vpsLogEl.textContent = st.vpsLog || "";
    vpsLogEl.classList.toggle("show", Boolean(st.vpsLog));

    renderWizardVerifyResult(st.verifyResult);
  }

  function collectWizardTargetForm() {
    return {
      name: $("wizTargetName").value.trim(),
      sshHost: $("wizTargetHost").value.trim(),
      sshPort: Number($("wizTargetPort").value) || 22,
      sshUser: $("wizTargetUser").value.trim() || "ubuntu",
      sshKeyPath: $("wizTargetKeyPath").value.trim(),
    };
  }

  function renderWizardTargetContext(targetProfile, activeProfile) {
    if (!targetProfile) return;
    const isSameAsActive = activeProfile && targetProfile.id === activeProfile.id;
    const targetDesc = targetProfile.name + (targetProfile.sshHost ? " (" + targetProfile.sshHost + ")" : "（未填 IP）");
    const activeDesc = activeProfile ? activeProfile.name : "主力服务器";

    const banner = $("wizTargetBanner");
    if (banner) {
      if (isSameAsActive) {
        banner.className = "target-banner warn";
        banner.innerHTML =
          "<strong>当前向导目标：" + escapeHtml(targetDesc) + "</strong>" +
          "<span>提示：这正是聊天正在使用的服务器。如要配置新 VPS，请先点上方「+ 新增服务器档案」，绝不会影响此主机。</span>";
      } else {
        banner.className = "target-banner safe";
        banner.innerHTML =
          "<strong>当前向导目标：" + escapeHtml(targetDesc) + "</strong>" +
          "<span>独立配置中 · 聊天侧边栏仍保持在「" + escapeHtml(activeDesc) + "」，互不干扰。</span>";
      }
    }

    const step2Tag = $("wizStep2Target");
    if (step2Tag) {
      step2Tag.textContent = "将作用于：" + targetDesc;
    }

    const finishBtn = $("wizFinishBtn");
    if (finishBtn) {
      finishBtn.textContent = isSameAsActive
        ? "关闭临时桌面并进入对话"
        : "关闭临时桌面并切换到「" + targetProfile.name + "」对话";
    }
  }

  const $ = (id) => document.getElementById(id);

  function switchTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-pane").forEach((p) => {
      p.classList.toggle("active", p.id === "tab-" + tabName);
    });
    if (tabName === "wizard") {
      vscode.postMessage({ type: "wizardRefreshLocal" });
    }
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  const toastBar = $("toastBar");
  const bridgeBadge = $("bridgeBadge");
  const testResultBox = $("testResultBox");
  const testConnBtn = $("testConnBtn");
  const pullMemoriesBtn = $("pullMemoriesBtn");
  const memoriesList = $("memoriesList");
  const skillsList = $("skillsList");
  const habitsList = $("habitsList");
  const habitsApplyRow = $("habitsApplyRow");
  const extractHabitsBtn = $("extractHabitsBtn");
  const syncSkillsNowBtn = $("syncSkillsNowBtn");
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

  function renderSkills(skills) {
    if (!skillsList) return;
    if (!skills || skills.length === 0) {
      skillsList.innerHTML =
        '<div class="memory-empty">本机 ~/.claude/skills/ 暂无 Skill。点下方「+ 新建本地 Skill 模板」即可创建一个！</div>';
      return;
    }
    skillsList.innerHTML = skills
      .map(
        (sk) =>
          '<div class="memory-item">' +
          '<div class="memory-info">' +
          '<div class="memory-title">/' + escapeHtml(sk.name) + ' <span class="skill-count-tag">' + sk.fileCount + " 个文件</span></div>" +
          '<div class="memory-preview">' + escapeHtml(sk.description || "自定义本地 Skill") + "</div>" +
          "</div>" +
          '<div class="memory-btns">' +
          '<button type="button" class="btn secondary small" data-open-skill="' + escapeHtml(sk.skillFilePath) + '">编辑</button>' +
          '<button type="button" class="btn secondary small" data-del-skill="' + escapeHtml(sk.dirName) + '">删除</button>' +
          "</div></div>"
      )
      .join("");

    skillsList.querySelectorAll("[data-open-skill]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "openSkill", path: btn.dataset.openSkill });
      });
    });
    skillsList.querySelectorAll("[data-del-skill]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "deleteSkill", dirName: btn.dataset.delSkill });
      });
    });
  }

  function renderHabits(habits) {
    if (!habitsList) return;
    if (!habits || habits.length === 0) {
      habitsList.innerHTML =
        '<div class="memory-empty">点击右上角「开始提炼新习惯」，从你最近纠正 AI 的历史发言里筛出尚未写入 CLAUDE.md 的个人偏好。</div>';
      if (habitsApplyRow) habitsApplyRow.style.display = "none";
      return;
    }
    habitsList.innerHTML = habits
      .map(
        (h, idx) =>
          '<label class="habit-item">' +
          '<input type="checkbox" class="habit-chk" data-habit-rule="' + encodeURIComponent(h.rule) + '" checked />' +
          '<div class="memory-info">' +
          '<div class="memory-title">' + escapeHtml(h.title) +
          ' <span class="skill-count-tag">' + (h.kind === "skill" ? "可拆 Skill" : "建议规则") + "</span></div>" +
          '<div class="habit-rule-text">' + escapeHtml(h.rule) + "</div>" +
          (h.reason ? '<div class="memory-meta">依据：' + escapeHtml(h.reason) + "</div>" : "") +
          "</div></label>"
      )
      .join("");
    if (habitsApplyRow) habitsApplyRow.style.display = "flex";
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
      profileName: $("profileName").value.trim(),
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
      syncLocalSkills: $("syncLocalSkills") ? $("syncLocalSkills").checked : true,
      localClaudeMdPaths: rulePaths.map((p) => p.trim()).filter(Boolean),
    };
  }

  $("saveBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "save", config: collectFormConfig(), reconnect: false });
  });

  $("saveReconnectBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "save", config: collectFormConfig(), reconnect: true });
  });

  $("deleteProfileBtn").addEventListener("click", () => {
    if (totalProfiles <= 1) {
      showToast(false, "至少需要保留 1 个服务器档案。");
      return;
    }
    vscode.postMessage({ type: "deleteProfile", profileId: activeProfileId });
  });

  function renderProfileBars(profiles, activeId, wizTargetId) {
    totalProfiles = (profiles || []).length;
    activeProfileId = activeId || "default";
    const nextWizId = wizTargetId || activeProfileId;
    $("deleteProfileBtn").disabled = totalProfiles <= 1;

    // 常规设置页：用于切换「聊天正在使用的服务器」
    const generalBar = $("profileBar");
    if (generalBar) {
      generalBar.innerHTML =
        (profiles || [])
          .map((p) => {
            const isAct = p.id === activeProfileId;
            const hostSub = p.sshHost
              ? '<span class="profile-chip-host">' + escapeHtml(p.sshHost) + "</span>"
              : '<span class="profile-chip-host">未配置</span>';
            return (
              '<button type="button" class="profile-chip ' + (isAct ? "active" : "") + '" data-select-profile="' + escapeHtml(p.id) + '">' +
              "<span>" + (isAct ? "● " : "") + escapeHtml(p.name) + "</span>" +
              hostSub +
              "</button>"
            );
          })
          .join("") +
        '<button type="button" class="profile-chip add" data-add-profile="general">+ 新增服务器档案</button>';

      generalBar.querySelectorAll("[data-select-profile]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset.selectProfile;
          if (pid && pid !== activeProfileId) {
            vscode.postMessage({
              type: "selectProfile",
              profileId: pid,
              reconnect: true,
            });
          }
        });
      });
      generalBar.querySelectorAll("[data-add-profile]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "createProfile" });
        });
      });
    }

    // 向导页：只切换「向导操作目标」，不影响聊天主力机，且标出哪台正在聊天中
    const wizBar = $("wizProfileBar");
    if (wizBar) {
      wizBar.innerHTML =
        (profiles || [])
          .map((p) => {
            const isTarget = p.id === nextWizId;
            const isChatActive = p.id === activeProfileId;
            const hostSub = p.sshHost
              ? '<span class="profile-chip-host">' + escapeHtml(p.sshHost) + "</span>"
              : '<span class="profile-chip-host">未配置</span>';
            const chatBadge = isChatActive
              ? '<span class="profile-chip-badge">聊天中</span>'
              : "";
            return (
              '<button type="button" class="profile-chip ' + (isTarget ? "active" : "") + '" data-wiz-target="' + escapeHtml(p.id) + '">' +
              "<span>" + (isTarget ? "● " : "") + escapeHtml(p.name) + "</span>" +
              hostSub +
              chatBadge +
              "</button>"
            );
          })
          .join("") +
        '<button type="button" class="profile-chip add" data-add-profile="wizard">+ 新增服务器档案</button>';

      wizBar.querySelectorAll("[data-wiz-target]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset.wizTarget;
          if (pid && pid !== wizardTargetProfileId) {
            snapshotWizardDomToStore(wizardTargetProfileId);
            vscode.postMessage({
              type: "selectWizardTarget",
              profileId: pid,
            });
          }
        });
      });
      wizBar.querySelectorAll("[data-add-profile]").forEach((btn) => {
        btn.addEventListener("click", () => {
          snapshotWizardDomToStore(wizardTargetProfileId);
          vscode.postMessage({ type: "createWizardProfile" });
        });
      });
    }
  }

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

  if (syncSkillsNowBtn) {
    syncSkillsNowBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "syncSkillsNow" });
    });
  }
  const refreshSkillsBtn = $("refreshSkillsBtn");
  if (refreshSkillsBtn) {
    refreshSkillsBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "refreshSkills" });
    });
  }
  const createSkillBtn = $("createSkillBtn");
  if (createSkillBtn) {
    createSkillBtn.addEventListener("click", () => {
      const name = $("newSkillName").value.trim();
      const description = $("newSkillDesc").value.trim();
      if (!name) {
        showToast(false, "请填写 Skill 英文标识（例如 embedded-c-review）。");
        return;
      }
      vscode.postMessage({ type: "createSkill", name, description });
      $("newSkillName").value = "";
      $("newSkillDesc").value = "";
    });
  }
  if (extractHabitsBtn) {
    extractHabitsBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "extractHabits" });
    });
  }
  const applyHabitsBtn = $("applyHabitsBtn");
  if (applyHabitsBtn) {
    applyHabitsBtn.addEventListener("click", () => {
      const checked = Array.from(document.querySelectorAll(".habit-chk:checked"))
        .map((el) => decodeURIComponent(el.dataset.habitRule || ""))
        .filter(Boolean);
      if (checked.length === 0) {
        showToast(false, "请至少勾选 1 条习惯后再采纳。");
        return;
      }
      vscode.postMessage({ type: "applyHabits", rules: checked });
    });
  }
  document.querySelectorAll("[data-settings-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.settingsTheme || "claude";
      document.body.dataset.theme = theme;
      document.querySelectorAll("[data-settings-theme]").forEach((b) => {
        b.classList.toggle("active", b.dataset.settingsTheme === theme);
      });
      vscode.postMessage({ type: "setChatTheme", theme });
    });
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

  // ===== 新机配置向导事件绑定 =====
  $("wizPickRootBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardPickProjectRoot" });
  });

  $("wizSetupLocalBtn").addEventListener("click", () => {
    const root = $("wizProjectRoot").value.trim();
    const logEl = $("wizLocalLog");
    logEl.textContent = "";
    logEl.classList.add("show");
    vscode.postMessage({ type: "wizardSetupLocal", projectRoot: root });
  });

  $("wizTogglePwBtn").addEventListener("click", () => {
    ownerPwVisible = !ownerPwVisible;
    $("wizOwnerPw").textContent = ownerPwVisible ? cachedOwnerToken : "••••••••••••";
    $("wizTogglePwBtn").textContent = ownerPwVisible ? "隐藏" : "显示";
  });

  function copyOwnerPassword() {
    if (!cachedOwnerToken) {
      showToast(false, "尚未检测到本地 DevSpace Owner Password，请先完成第 1 步。");
      return;
    }
    vscode.postMessage({ type: "copyText", text: cachedOwnerToken });
  }
  $("wizCopyPwBtn").addEventListener("click", copyOwnerPassword);
  $("wizCopyPwBtn2").addEventListener("click", copyOwnerPassword);

  $("wizPickKeyBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "pickWizardKeyFile" });
  });

  $("wizSaveTargetBtn").addEventListener("click", () => {
    vscode.postMessage({
      type: "saveWizardTarget",
      target: collectWizardTargetForm(),
    });
  });

  $("wizPasswordlessBtn").addEventListener("click", () => {
    const targetForm = collectWizardTargetForm();
    const host = $("pwHost").value.trim() || targetForm.sshHost;
    const port = Number($("pwPort").value) || targetForm.sshPort || 22;
    const loginUser = $("pwUser").value.trim() || "root";
    const password = $("pwPassword").value;
    if (!host || !password) {
      showToast(false, "请填写 VPS 地址和一次性登录密码。");
      return;
    }
    const st = getWizardStore(wizardTargetProfileId);
    st.passwordlessLog = "";
    const logEl = $("wizPasswordlessLog");
    logEl.textContent = "";
    logEl.classList.add("show");
    snapshotWizardDomToStore(wizardTargetProfileId);
    vscode.postMessage({
      type: "wizardSetupPasswordless",
      target: targetForm,
      host,
      port,
      loginUser,
      password,
      createNonRootUser: $("pwCreateNonRoot").checked,
      newUserName: $("pwNewUserName").value.trim() || "claude",
    });
  });

  $("wizSetupVpsBtn").addEventListener("click", () => {
    const st = getWizardStore(wizardTargetProfileId);
    st.vpsLog = "";
    const logEl = $("wizVpsLog");
    logEl.textContent = "";
    logEl.classList.add("show");
    snapshotWizardDomToStore(wizardTargetProfileId);
    vscode.postMessage({
      type: "wizardSetupVps",
      target: collectWizardTargetForm(),
      timezone: $("wizTimezone").value,
      withDesktop: $("wizWithDesktop").checked,
      geometry: $("wizGeometry").value,
    });
  });

  $("wizStartDesktopBtn").addEventListener("click", () => {
    snapshotWizardDomToStore(wizardTargetProfileId);
    vscode.postMessage({
      type: "wizardStartDesktop",
      target: collectWizardTargetForm(),
      geometry: $("wizGeometry").value,
    });
  });

  $("wizReopenDesktopBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardOpenDesktopUrl" });
  });

  $("wizStopDesktopBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardStopDesktop" });
  });

  $("wizSyncClipboardBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardSyncClipboard" });
  });

  $("wizSendPwToRemoteBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardPushDevspacePassword" });
  });

  $("wizVerifyBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardVerify" });
  });

  $("wizFinishBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "wizardFinish" });
  });

  function renderLocalChecklist(st) {
    const el = $("wizLocalChecklist");
    if (!st) {
      el.innerHTML = '<span class="check-pill">正在检测本机环境...</span>';
      return;
    }
    const pill = (ok, label) =>
      '<span class="check-pill ' + (ok ? "ok" : "warn") + '">' + (ok ? "✓ " : "○ ") + escapeHtml(label) + "</span>";
    el.innerHTML =
      pill(st.nodeOk, "Node " + st.nodeVersion) +
      pill(st.devspaceInstalled, st.devspaceInstalled ? "DevSpace v" + st.devspaceVersion : "DevSpace 未安装") +
      pill(st.configExists && st.allowedRoots.length > 0, st.allowedRoots.length > 0 ? "已授权 " + st.allowedRoots.length + " 个目录" : "尚未初始化") +
      pill(st.subagentsDisabled, st.subagentsDisabled ? "本地 subagents 已关闭" : "建议关闭本地 subagents") +
      pill(st.oauthDays >= 180, "OAuth 有效期 " + st.oauthDays + " 天");

    if (!$("wizProjectRoot").value.trim() && st.allowedRoots.length > 0) {
      $("wizProjectRoot").value = st.allowedRoots[0];
    }

    cachedOwnerToken = st.ownerToken || "";
    const pwRow = $("wizPasswordRow");
    if (cachedOwnerToken) {
      pwRow.style.display = "flex";
      $("wizOwnerPw").textContent = ownerPwVisible ? cachedOwnerToken : "••••••••••••";
    } else {
      pwRow.style.display = "none";
    }
  }

  function renderDesktopState(ds) {
    if (!ds) return;
    let statusText = "当前状态：" + (ds.detail || "未启动");
    if (ds.running && ds.profileId && ds.profileId !== wizardTargetProfileId) {
      statusText += "（属于「" + (ds.profileName || ds.profileId) + "」）";
    }
    $("wizDesktopStatus").textContent = statusText;
    $("wizReopenDesktopBtn").style.display = ds.running ? "inline-block" : "none";
    $("wizStopDesktopBtn").style.display = ds.running ? "inline-block" : "none";
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === "state") {
      const p = msg.payload;
      const cfg = p.config;
      if (cfg && cfg.chatTheme) {
        document.body.dataset.theme = cfg.chatTheme;
      }
      envProxyStr = p.envProxy || "";

      // 状态徽标
      const st = p.bridge?.status || "disconnected";
      const label =
        st === "connected" ? "已连接" : st === "connecting" ? "连接中..." : st === "error" ? "已断开" : "未连接";
      bridgeBadge.innerHTML = '<span class="dot ' + escapeHtml(st) + '"></span><span>' + label + "</span>";
      bridgeBadge.title = p.bridge?.detail || "";

      // 填充服务器档案与表单（常规页显示聊天活跃机，向导页独立显示向导目标机）
      const actProf = p.activeProfile || null;
      const wizProf = p.wizardTargetProfile || actProf;
      cachedActiveProfile = actProf;
      cachedWizardTargetProfile = wizProf;

      const prevWizId = wizardTargetProfileId;
      const nextWizId = (wizProf && wizProf.id) || (actProf && actProf.id) || "default";
      const switchedWizTarget = prevWizId !== nextWizId;
      if (switchedWizTarget && prevWizId) {
        snapshotWizardDomToStore(prevWizId);
      }
      wizardTargetProfileId = nextWizId;

      renderProfileBars(p.profiles || [], actProf && actProf.id, nextWizId);
      renderWizardTargetContext(wizProf, actProf);

      // 仅当向导目标切换或后端数据更新时同步向导目标字段，避免打断用户输入
      if (wizProf) {
        const targetKey = JSON.stringify([
          wizProf.id,
          wizProf.name,
          wizProf.sshHost,
          wizProf.sshPort,
          wizProf.sshUser,
          wizProf.sshKeyPath,
        ]);
        if (switchedWizTarget || targetKey !== lastSyncedWizardTargetKey) {
          lastSyncedWizardTargetKey = targetKey;
          $("wizTargetName").value = wizProf.name || "";
          $("wizTargetHost").value = wizProf.sshHost || "";
          $("wizTargetPort").value = wizProf.sshPort || 22;
          $("wizTargetUser").value = wizProf.sshUser || "ubuntu";
          $("wizTargetKeyPath").value = wizProf.sshKeyPath || "";
          const st = getWizardStore(wizProf.id);
          if (wizProf.sshHost && !st.pwHost) {
            st.pwHost = wizProf.sshHost;
          }
          if (wizProf.sshPort && !st.pwPort) {
            st.pwPort = String(wizProf.sshPort);
          }
          restoreWizardDomFromStore(wizProf);
        }
      }

      $("profileName").value = (actProf && actProf.name) || "主力服务器";
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
      if ($("syncLocalSkills")) {
        $("syncLocalSkills").checked = cfg.syncLocalSkills !== false;
      }
      const activeTheme = cfg.chatTheme || "claude";
      document.querySelectorAll("[data-settings-theme]").forEach((b) => {
        b.classList.toggle("active", b.dataset.settingsTheme === activeTheme);
      });

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
      renderSkills(p.skills || []);
      renderHabits(p.habits || []);
      renderMemories(p.memories || []);
      renderLocalChecklist(p.localStatus);
      renderDesktopState(p.desktopState);

      if (
        p.activeTab === "server" ||
        p.activeTab === "knowledge" ||
        p.activeTab === "preferences" ||
        p.activeTab === "wizard"
      ) {
        switchTab(p.activeTab);
      }

      if (p.focusSection) {
        const targetEl = document.getElementById("section-" + p.focusSection);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      return;
    }

    if (msg.type === "wizardPickedRoot" && msg.path) {
      $("wizProjectRoot").value = msg.path;
      return;
    }

    if (msg.type === "wizardLog") {
      if (msg.target === "local") {
        const logEl = $("wizLocalLog");
        if (logEl) {
          logEl.classList.add("show");
          logEl.textContent += (logEl.textContent ? "\n" : "") + (msg.line || "");
          logEl.scrollTop = logEl.scrollHeight;
        }
        return;
      }

      const pid = msg.profileId || wizardTargetProfileId;
      const st = getWizardStore(pid);
      if (msg.target === "passwordless") {
        st.passwordlessLog += (st.passwordlessLog ? "\n" : "") + (msg.line || "");
      } else {
        st.vpsLog += (st.vpsLog ? "\n" : "") + (msg.line || "");
      }

      // 仅当日志属于当前正在查看的向导目标服务器时，才刷新到界面黑框
      if (pid === wizardTargetProfileId) {
        const logEl = msg.target === "passwordless" ? $("wizPasswordlessLog") : $("wizVpsLog");
        if (logEl) {
          logEl.classList.add("show");
          logEl.textContent = msg.target === "passwordless" ? st.passwordlessLog : st.vpsLog;
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      return;
    }

    if (msg.type === "passwordlessDone") {
      // 无论成败，完成后立刻清空前端密码输入框，绝不残留明文
      $("pwPassword").value = "";
      return;
    }

    if (msg.type === "wizardBusy") {
      const busy = Boolean(msg.busy);
      if (msg.step === "local") {
        $("wizSetupLocalBtn").disabled = busy;
        $("wizSetupLocalBtn").textContent = busy ? "正在安装初始化..." : "一键安装并初始化";
      } else if (msg.step === "passwordless") {
        $("wizPasswordlessBtn").disabled = busy;
        $("wizPasswordlessBtn").textContent = busy
          ? "正在生成并部署免密密钥..."
          : "用密码一键配置免密登录";
      } else if (msg.step === "vps") {
        $("wizSetupVpsBtn").disabled = busy;
        $("wizSetupVpsBtn").textContent = busy ? "正在初始化 VPS（约 1~3 分钟）..." : "一键初始化远程 VPS";
      } else if (msg.step === "desktop") {
        $("wizStartDesktopBtn").disabled = busy;
        $("wizStartDesktopBtn").textContent = busy ? "正在启动远程画面..." : "打开远程登录画面（网页直连）";
      } else if (msg.step === "clipboard") {
        $("wizSyncClipboardBtn").disabled = busy;
        $("wizSendPwToRemoteBtn").disabled = busy;
        $("wizSyncClipboardBtn").textContent = busy ? "正在同步..." : "同步本机剪贴板到远程";
      } else if (msg.step === "verify") {
        $("wizVerifyBtn").disabled = busy;
        $("wizVerifyBtn").textContent = busy ? "正在检测..." : "一键检测授权状态";
      }
      return;
    }

    if (msg.type === "wizardVerifyResult" && msg.result) {
      const pid = msg.profileId || wizardTargetProfileId;
      const st = getWizardStore(pid);
      st.verifyResult = msg.result;
      if (pid === wizardTargetProfileId) {
        renderWizardVerifyResult(msg.result);
      }
      return;
    }

    if (msg.type === "pickedWizardKeyFile") {
      $("wizTargetKeyPath").value = msg.path || "";
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

    if (msg.type === "skillsBusy" && syncSkillsNowBtn) {
      syncSkillsNowBtn.disabled = Boolean(msg.busy);
      syncSkillsNowBtn.textContent = msg.busy ? "正在同步 Skill..." : "立即同步 Skill 到当前 VPS";
      return;
    }

    if (msg.type === "habitsLoading" && extractHabitsBtn) {
      extractHabitsBtn.disabled = Boolean(msg.loading);
      extractHabitsBtn.textContent = msg.loading ? "正在分析对话记录..." : "开始提炼新习惯";
      return;
    }

    if (msg.type === "toast") {
      showToast(Boolean(msg.ok), msg.message || "");
    }
  });

  vscode.postMessage({ type: "ready" });
})();
