const state = {
  hosts: [],
  hostScans: {},
  currentJob: null,
  pollTimer: null,
  toastTimer: null,
  notifiedJobs: {},
  recentJobs: [],
  recentJobsSignature: "",
  rolePage: 1,
  rolePageSize: 25,
  roleSearch: "",
  roleFilter: "",
  resultGroups: [],
  resultSignature: "",
  lastResultRenderAt: 0,
  pendingResultData: null,
  resultRenderTimer: null,
  openResultGroupKey: "",
  saveTimer: null,
  dirty: false,
  stopRequested: false,
};

const $ = (id) => document.getElementById(id);
const ROLE_VIEW_KEY = "roceRoleView";
const JOB_WIDGET_COLLAPSED_KEY = "roceJobWidgetCollapsed";

function api(path, options = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  });
}

function loadRoleViewState() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROLE_VIEW_KEY) || "{}");
    if (saved.rolePageSize) state.rolePageSize = Number(saved.rolePageSize) || state.rolePageSize;
    if (saved.rolePage) state.rolePage = Number(saved.rolePage) || state.rolePage;
    if (typeof saved.roleSearch === "string") state.roleSearch = saved.roleSearch;
    if (typeof saved.roleFilter === "string") state.roleFilter = saved.roleFilter;
  } catch {
    localStorage.removeItem(ROLE_VIEW_KEY);
  }
}

function saveRoleViewState() {
  localStorage.setItem(
    ROLE_VIEW_KEY,
    JSON.stringify({
      rolePage: state.rolePage,
      rolePageSize: state.rolePageSize,
      roleSearch: state.roleSearch,
      roleFilter: state.roleFilter,
    })
  );
}

function optionList(values, selectedValue, emptyLabel) {
  const seen = new Set();
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
  values.forEach((item) => {
    const value = typeof item === "string" ? item : item.value;
    const label = typeof item === "string" ? item : item.label;
    if (!value || seen.has(value)) return;
    seen.add(value);
    const selected = String(value) === String(selectedValue || "") ? "selected" : "";
    options.push(`<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label || value)}</option>`);
  });
  if (selectedValue && !seen.has(selectedValue)) {
    options.push(`<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)}（当前）</option>`);
  }
  return options.join("");
}

function scanOptionsFor(host) {
  const scan = state.hostScans[host.id] || {
    devices: host.scanDevices || [],
    addresses: host.scanAddresses || [],
  };
  const selectedPair = host.device || host.roceIp ? `${host.device || ""}@@${host.roceIp || ""}` : "";
  const pairs = [];
  (scan.devices || []).forEach((item) => {
    const addresses = item.addresses || [];
    addresses.filter(Boolean).forEach((address) => {
      pairs.push({
        value: `${item.device || ""}@@${address || ""}`,
        label: [item.device, item.netdev, address].filter(Boolean).join(" / "),
      });
    });
  });
  if (!pairs.length && host.device && host.roceIp) {
    pairs.push({
      value: selectedPair,
      label: [host.device, host.roceIp].filter(Boolean).join(" / "),
    });
  }
  return {
    pairOptions: optionList(pairs, selectedPair, "扫描后选择 RoCE 网卡 / IP"),
  };
}

function availableDeviceNames() {
  const names = new Set();
  state.hosts.forEach((host) => {
    (host.scanDevices || []).forEach((item) => {
      if (item.device && (item.addresses || []).some(Boolean)) names.add(item.device);
    });
    if (host.device) names.add(host.device);
  });
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function updateBulkDeviceSelect() {
  const select = $("bulkDeviceSelect");
  if (!select) return;
  const devices = availableDeviceNames();
  select.innerHTML = [
    '<option value="">批量选择网卡</option>',
    ...devices.map((device) => `<option value="${escapeHtml(device)}">${escapeHtml(device)}</option>`),
  ].join("");
  select.value = "";
  select.disabled = devices.length === 0;
  select.title = devices.length ? "把已启用机器批量切换到同一张网卡" : "扫描服务器后可批量选择网卡";
}

function applyDeviceToHost(host, device) {
  const matched = (host.scanDevices || []).find((item) => item.device === device && (item.addresses || []).some(Boolean));
  if (matched) {
    host.device = matched.device || device;
    host.roceIp = (matched.addresses || []).find(Boolean) || "";
    return true;
  }
  if (host.device === device && host.roceIp) return true;
  return false;
}

async function applyBulkDevice(device) {
  if (!device) return;
  const targets = state.hosts.filter((host) => host.enabled !== false);
  if (!targets.length) {
    showToast("没有已启用的机器可批量选择网卡。", "bad", 4200);
    return;
  }
  let changed = 0;
  const skipped = [];
  targets.forEach((host) => {
    if (applyDeviceToHost(host, device)) changed += 1;
    else skipped.push(host.name || host.address || host.id);
  });
  renderHosts();
  if (changed) {
    scheduleRoleSave();
  }
  const suffix = skipped.length ? `，${skipped.length} 台未找到 ${device} 或没有 IP，已跳过。` : "。";
  showToast(`已将 ${changed} 台启用机器切换到 ${device}${suffix}`, skipped.length ? "info" : "ok", 5200);
}

function hostRow(host) {
  const tr = document.createElement("tr");
  const classes = ["role-row"];
  if (host.enabled !== false) classes.push("enabled-row");
  else classes.push("disabled-row");
  if (host.role === "server") classes.push("role-server");
  if (host.role === "client") classes.push("role-client");
  tr.className = classes.join(" ");
  const serverOptions = serverTargetOptions(host.targetServerId);
  const { pairOptions } = scanOptionsFor(host);
  tr.innerHTML = `
    <td class="enabled-cell">
      <input class="row-toggle" data-key="enabled" type="checkbox" ${host.enabled !== false ? "checked" : ""}>
    </td>
    <td>
      <div class="host-title">
        ${escapeHtml(host.name || host.address || "")}
        <span class="row-state ${host.enabled !== false ? "on" : "off"}">${host.enabled !== false ? "启用" : "停用"}</span>
      </div>
      <div class="host-subtitle">${escapeHtml(host.address || "")}:${escapeHtml(host.sshPort || "22")} · ${escapeHtml(host.sshUser || "root")}</div>
    </td>
    <td>
      <div class="role-switch" role="group" aria-label="选择角色">
        <button class="${host.role === "server" ? "active" : ""}" data-role-choice="server" type="button">server</button>
        <button class="${host.role === "client" ? "active" : ""}" data-role-choice="client" type="button">client</button>
      </div>
    </td>
    <td>
      <select data-key="targetServerId" ${host.role === "client" ? "" : "disabled"}>
        ${serverOptions}
      </select>
    </td>
    <td class="role-device-cell">
      <div class="device-control">
        <select data-key="devicePair">
          ${pairOptions}
        </select>
        <button class="scan-host" data-scan type="button">${state.hostScans[host.id] ? "重扫" : "扫描"}</button>
      </div>
    </td>
    <td class="optional-col"><input data-key="gidIndex" placeholder="可空" value="${escapeHtml(host.gidIndex ?? "")}"></td>
    <td class="optional-col"><input data-key="port" placeholder="可空" value="${escapeHtml(host.port || "")}"></td>
  `;
  tr.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", () => {
      syncHostFromRow(host, tr);
      scheduleRoleSave();
    });
    input.addEventListener("change", () => {
      syncHostFromRow(host, tr);
      scheduleRoleSave();
      if (input.classList.contains("row-toggle") && host.role !== "server" && filteredRoleHosts().includes(host)) {
        updateHostRowState(host, tr);
        updateRoleStats(filteredRoleHosts());
        updateBulkDeviceSelect();
        saveRoleViewState();
        return;
      }
      renderHosts();
    });
  });
  tr.querySelectorAll("[data-role-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      if (host.role === button.dataset.roleChoice) return;
      host.role = button.dataset.roleChoice;
      if (host.role === "server") host.targetServerId = "";
      scheduleRoleSave();
      renderHosts();
    });
  });
  tr.querySelector("[data-scan]").addEventListener("click", () => {
    scanHost(host).catch((err) => {
      showToast(`扫描失败：${err.message}`, "bad", 5200);
    });
  });
  return tr;
}

function updateHostRowState(host, tr) {
  tr.classList.toggle("enabled-row", host.enabled !== false);
  tr.classList.toggle("disabled-row", host.enabled === false);
  tr.classList.toggle("role-server", host.role === "server");
  tr.classList.toggle("role-client", host.role === "client");
  const stateLabel = tr.querySelector(".row-state");
  if (stateLabel) {
    stateLabel.classList.toggle("on", host.enabled !== false);
    stateLabel.classList.toggle("off", host.enabled === false);
    stateLabel.textContent = host.enabled !== false ? "启用" : "停用";
  }
}

function serverTargetOptions(selectedId) {
  const servers = state.hosts.filter((item) => item.enabled !== false && item.role === "server");
  const options = ['<option value="">自动</option>'];
  servers.forEach((server) => {
    const label = server.name || server.address || server.id;
    const selected = String(server.id) === String(selectedId) ? "selected" : "";
    options.push(`<option value="${escapeHtml(server.id)}" ${selected}>${escapeHtml(label)}</option>`);
  });
  return options.join("");
}

function syncHostFromRow(host, tr) {
  tr.querySelectorAll("[data-key]").forEach((input) => {
    const key = input.dataset.key;
    if (key === "devicePair") {
      const [device, roceIp] = input.value.split("@@");
      host.device = device || "";
      host.roceIp = roceIp || "";
      return;
    }
    host[key] = input.type === "checkbox" ? input.checked : input.value;
  });
}

function renderHosts() {
  normalizeTargetServers();
  const body = $("hostsBody");
  const filtered = filteredRoleHosts();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.rolePageSize));
  state.rolePage = Math.min(Math.max(1, state.rolePage), totalPages);
  const start = (state.rolePage - 1) * state.rolePageSize;
  const rows = filtered.slice(start, start + state.rolePageSize);
  body.innerHTML = "";
  rows.forEach((host) => body.appendChild(hostRow(host)));
  $("rolePageInfo").textContent = filtered.length ? `${start + 1}-${start + rows.length} / ${filtered.length}` : "0-0 / 0";
  $("rolePrevPage").disabled = state.rolePage <= 1;
  $("roleNextPage").disabled = state.rolePage >= totalPages;
  updateRoleStats(filtered);
  updateBulkDeviceSelect();
  saveRoleViewState();
}

function filteredRoleHosts() {
  const keyword = state.roleSearch.trim().toLowerCase();
  return state.hosts.filter((host) => {
    if (state.roleFilter === "enabled" && host.enabled === false) return false;
    if (state.roleFilter === "server" && !(host.enabled !== false && host.role === "server")) return false;
    if (state.roleFilter === "client" && !(host.enabled !== false && host.role === "client")) return false;
    if (!keyword) return true;
    return [host.name, host.address, host.sshUser, host.role, host.device, host.roceIp]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
}

function updateRoleStats(filtered) {
  const enabled = state.hosts.filter((host) => host.enabled !== false);
  $("roleTotalStat").textContent = `总计 ${state.hosts.length}`;
  $("roleEnabledStat").textContent = `启用 ${enabled.length}`;
  $("roleServerStat").textContent = `Server ${enabled.filter((host) => host.role === "server").length}`;
  $("roleClientStat").textContent = `Client ${enabled.filter((host) => host.role === "client").length}`;
  document.querySelectorAll("[data-role-filter]").forEach((item) => {
    item.classList.toggle("active", item.dataset.roleFilter === state.roleFilter);
  });
  $("rolePageInfo").title = filtered.length === state.hosts.length ? "" : `过滤后 ${filtered.length} 台`;
}

function normalizeTargetServers() {
  state.hosts.forEach((host, index) => {
    if (!host.id) host.id = crypto.randomUUID();
    if (!host.name) host.name = `host-${index + 1}`;
    if (!host.sshUser) host.sshUser = "root";
    if (!host.sshPort) host.sshPort = "22";
    if (!host.role || host.role === "disabled") host.role = "client";
    if (!host.device) host.device = "mlx5_0";
    if (host.gidIndex === undefined || host.gidIndex === null) host.gidIndex = "";
    if (host.port === undefined || host.port === null) host.port = "";
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function collectConfig(dryRun = true) {
  const useAdvancedRole = $("showAdvancedRole").checked;
  const hosts = state.hosts.map((host) => {
    if (useAdvancedRole) return host;
    return {
      ...host,
      gidIndex: "",
      port: "",
    };
  });
  return {
    dryRun,
    testType: $("testType").value,
    basePort: $("basePort").value,
    duration: $("duration").value,
    qp: $("qp").value,
    txDepth: $("txDepth").value,
    size: $("size").value.trim(),
    mtu: $("mtu").value.trim(),
    allSizes: $("allSizes").checked,
    runInfinitely: $("runInfinitely").checked,
    serverWarmup: $("serverWarmup").value,
    clientStagger: $("clientStagger").value,
    hosts,
  };
}

function endpointKey(host) {
  const address = String(host.address || "");
  const device = String(host.device || "");
  if (device) return `${address}|${device}`;
  return `${address}|${String(host.roceIp || "")}`;
}

function hostLabel(host) {
  return host.name || host.address || "未命名服务器";
}

function validateOneToOne(config) {
  const hosts = (config.hosts || []).filter((host) => host.enabled !== false);
  const servers = hosts.filter((host) => host.role === "server");
  const clients = hosts.filter((host) => host.role === "client");
  if (!servers.length) throw new Error("至少需要一台 server");
  if (!clients.length) throw new Error("至少需要一台 client");

  const serversById = new Map(servers.map((host) => [String(host.id || ""), host]));
  const usedServers = new Set();
  const usedClients = new Set();

  clients.forEach((client) => {
    const clientKey = endpointKey(client);
    if (usedClients.has(clientKey)) {
      throw new Error(`client 网卡重复使用：${hostLabel(client)} ${client.device || ""}`);
    }
    usedClients.add(clientKey);

    let server = null;
    if (client.targetServerId) {
      server = serversById.get(String(client.targetServerId));
      if (!server) throw new Error(`${hostLabel(client)} 指定的目标 server 不存在`);
      const serverKey = endpointKey(server);
      if (usedServers.has(serverKey)) {
        throw new Error(`${hostLabel(client)} 指定的目标 server 网卡已被占用：${hostLabel(server)} ${server.device || ""}`);
      }
    } else {
      server = servers.find((item) => !usedServers.has(endpointKey(item)));
      if (!server) throw new Error("可用 server 网卡数量不足：每个 server 网卡只能被一个 client 使用");
    }
    usedServers.add(endpointKey(server));
  });
}

async function assertNoActiveJob() {
  const data = await api("/api/jobs");
  const active = (data.jobs || []).find((job) => ["queued", "running"].includes(job.status));
  if (active) {
    throw new Error(`已有任务正在运行：${active.id}，请先停止或等待完成`);
  }
}

async function loadHosts() {
  const data = await api("/api/hosts");
  state.hosts = data.hosts;
  state.hostScans = {};
  state.hosts.forEach((host) => {
    if ((host.scanDevices && host.scanDevices.length) || (host.scanAddresses && host.scanAddresses.length)) {
      state.hostScans[host.id] = {
        devices: host.scanDevices || [],
        addresses: host.scanAddresses || [],
      };
    }
  });
  renderHosts();
}

async function saveHosts({ silent = false } = {}) {
  await api("/api/topology", {
    method: "POST",
    body: JSON.stringify({ hosts: state.hosts }),
  });
  state.dirty = false;
  if (!silent) showToast("角色和打流配置已自动保存。", "ok");
}

function scheduleRoleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    saveHosts({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
  }, 450);
}

function flushRoleSave() {
  if (!state.dirty || !state.hosts.length) return;
  clearTimeout(state.saveTimer);
  const payload = JSON.stringify({ hosts: state.hosts });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/topology", payload);
  }
  state.dirty = false;
}

function showToast(message, type = "info", timeout = 3600) {
  const toast = $("toast");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  if (timeout) {
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, timeout);
  }
}

function setStartButtonLocked(locked) {
  const button = $("runReal");
  button.disabled = locked;
  button.textContent = locked ? "任务运行中" : "开始测试！";
}

function setStopButtonState(active, stopping = false) {
  const button = $("stopJob");
  if (!button) return;
  button.disabled = !active || stopping;
  button.textContent = stopping ? "停止中..." : "停止当前任务";
}

function statusText(status, rows = []) {
  return {
    queued: "排队中",
    running: "运行中",
    finished: "已完成",
    stopped: rows.length ? "已完成" : "已停止",
    failed: "失败",
  }[status] || "未知";
}

function displayLogs(data, rows = parseResultLines(data.results || []).rows) {
  const logs = data.logs || [];
  if (data.status === "stopped" && rows.length) {
    return logs.filter((line) => !line.includes("停止失败"));
  }
  return logs;
}

function updateJobStatusWidget(data = null) {
  const widget = $("jobStatusWidget");
  if (!widget) return;
  const isCollapsed = widget.classList.contains("collapsed");
  if (!data) {
    widget.className = "job-status-widget idle";
    if (isCollapsed) widget.classList.add("collapsed");
    $("jobStatusTitle").textContent = "当前无任务";
    $("jobStatusMeta").textContent = "启动测试后这里会显示实时状态";
    return;
  }
  const { rows } = parseResultLines(data.results || []);
  const logs = displayLogs(data, rows);
  const lastLogRaw = logs.length ? logs[logs.length - 1].replace(/^\[[^\]]+\]\s*/, "") : "等待任务输出";
  const lastLog = lastLogRaw.length > 42 ? `${lastLogRaw.slice(0, 42)}...` : lastLogRaw;
  const isActive = ["queued", "running"].includes(data.status);
  widget.className = `job-status-widget ${data.status || "idle"}`;
  if (isCollapsed) widget.classList.add("collapsed");
  $("jobStatusTitle").textContent = `${statusText(data.status, rows)} · ${data.id}`;
  $("jobStatusMeta").textContent = `${rows.length} 条结果 · ${isActive ? "正在更新" : "最后状态"} · ${lastLog}`;
}

function setJobWidgetCollapsed(collapsed) {
  const widget = $("jobStatusWidget");
  if (!widget) return;
  widget.classList.toggle("collapsed", collapsed);
  $("toggleJobWidget").textContent = collapsed ? "展开" : "收起";
  localStorage.setItem(JOB_WIDGET_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function rememberRecentJob(job) {
  if (!job || !job.id) return;
  state.recentJobs = [job, ...state.recentJobs.filter((item) => item.id !== job.id)].slice(0, 5);
  renderRecentJobs();
}

function renderRecentJobs() {
  const list = $("recentJobsList");
  if (!list) return;
  if (!state.recentJobs.length) {
    state.recentJobsSignature = "empty";
    list.innerHTML = `<div class="recent-job-empty">暂无历史任务</div>`;
    return;
  }
  const renderedJobs = state.recentJobs.slice(0, 5).map((job) => {
    const { rows } = parseResultLines(job.results || []);
    const best = rows.length ? Math.max(...rows.map((row) => row.average)) : 0;
    const resultText = rows.length ? `${formatNumber(best)} Gb/s` : `${rows.length} 条`;
    const endpointText = recentJobEndpointText(job, rows);
    const active = ["queued", "running"].includes(job.status);
    return { job, rows, best, resultText, endpointText, active };
  });
  const signature = renderedJobs
    .map((item) =>
      item.active
        ? [item.job.id, item.job.status, item.endpointText, "active"].join(":")
        : [item.job.id, item.job.status, item.rows.length, item.resultText, item.endpointText].join(":")
    )
    .join("|");
  if (signature === state.recentJobsSignature) return;
  state.recentJobsSignature = signature;
  list.innerHTML = renderedJobs
    .slice(0, 5)
    .map(({ job, rows, resultText, endpointText, active }) => {
      return `
        <div class="recent-job-item ${escapeHtml(job.status || "idle")}" data-open-job="${escapeHtml(job.id)}" title="查看历史任务 ${escapeHtml(job.id)}">
          <span>${escapeHtml(statusText(job.status, rows))}</span>
          <strong>${escapeHtml(job.id)}</strong>
          <small>${escapeHtml(endpointText)}</small>
          <em>${escapeHtml(resultText)}</em>
          ${
            active
              ? `<button class="recent-job-action recent-job-stop" data-stop-job="${escapeHtml(job.id)}" type="button" title="停止任务 ${escapeHtml(job.id)}">停止</button>`
              : `<button class="recent-job-action recent-job-rerun" data-rerun-job="${escapeHtml(job.id)}" type="button" title="重新发起 ${escapeHtml(job.id)}">重测</button>`
          }
        </div>`;
    })
    .join("");
  list.querySelectorAll("[data-open-job]").forEach((item) => {
    item.addEventListener("click", () => {
      window.location.href = `/history.html?job=${encodeURIComponent(item.dataset.openJob)}`;
    });
  });
  list.querySelectorAll("[data-stop-job]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "停止中";
      stopRecentJob(button.dataset.stopJob).catch((err) => {
        if (state.currentJob === button.dataset.stopJob) {
          state.stopRequested = false;
          setStopButtonState(true);
        }
        state.recentJobsSignature = "";
        renderRecentJobs();
        showToast(`停止失败：${err.message}`, "bad", 7000);
      });
    });
  });
  list.querySelectorAll("[data-rerun-job]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      rerunJob(button.dataset.rerunJob).catch((err) => showToast(`重测失败：${err.message}`, "bad", 7000));
    });
  });
}

async function loadRecentJobs() {
  const data = await api("/api/jobs");
  state.recentJobs = (data.jobs || []).slice(0, 5);
  renderRecentJobs();
}

async function stopRecentJob(jobId) {
  if (!jobId) return;
  if (state.currentJob === jobId) {
    state.stopRequested = true;
    setStopButtonState(true, true);
  }
  await api(`/api/jobs/${jobId}/stop`, { method: "POST", body: "{}" });
  showToast(`已发送停止请求：${jobId}`, "ok", 3200);
  if (state.currentJob === jobId) {
    await pollJob({ notify: false });
  }
  await loadRecentJobs();
}

async function rerunJob(jobId) {
  if (!jobId) return;
  const data = await api(`/api/jobs/${jobId}/rerun`, { method: "POST", body: "{}" });
  state.currentJob = data.id;
  state.stopRequested = false;
  setStartButtonLocked(true);
  setStopButtonState(true);
  delete state.notifiedJobs[data.id];
  localStorage.setItem("roceCurrentJob", data.id);
  state.resultSignature = "";
  state.resultGroups = [];
  state.openResultGroupKey = "";
  $("resultOutput").className = "result-view empty";
  $("resultOutput").textContent = "等待任务输出...";
  updateJobStatusWidget({ id: data.id, status: "queued", logs: [`从任务 ${jobId} 重新发起`], results: [] });
  rememberRecentJob({ id: data.id, status: "queued", logs: [`从任务 ${jobId} 重新发起`], results: [] });
  showToast(`已重新发起任务：${data.id}`, "ok", 4200);
  pollJob();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollJob, 1000);
}

function applyScanResult(host, data) {
  state.hostScans[host.id] = {
    devices: data.devices || [],
    addresses: data.addresses || [],
  };
  host.scanDevices = state.hostScans[host.id].devices;
  host.scanAddresses = state.hostScans[host.id].addresses;
  const firstDevice = state.hostScans[host.id].devices.find((item) => item.addresses && item.addresses.length);
  if (firstDevice && firstDevice.device) host.device = firstDevice.device;
  if (firstDevice && firstDevice.addresses && firstDevice.addresses[0]) {
    host.roceIp = firstDevice.addresses[0];
  } else if (state.hostScans[host.id].addresses[0]) {
    host.roceIp = state.hostScans[host.id].addresses[0];
  }
  return state.hostScans[host.id];
}

async function saveScanCache(host) {
  const scan = state.hostScans[host.id] || { devices: [], addresses: [] };
  await api("/api/hosts/scan-cache", {
    method: "POST",
    body: JSON.stringify({
      hostId: host.id,
      scanDevices: scan.devices,
      scanAddresses: scan.addresses,
      device: host.device || "",
      roceIp: host.roceIp || "",
    }),
  });
}

async function scanHost(host, quiet = false) {
  const targetName = host.name || host.address || "服务器";
  if (!quiet) {
    showToast(`正在扫描 ${targetName}...`, "info", 0);
  }
  const data = await api("/api/hosts/scan", {
    method: "POST",
    body: JSON.stringify({ hostId: host.id, host }),
  });
  const scan = applyScanResult(host, data);
  renderHosts();
  const deviceCount = scan.devices.length;
  const addressCount = scan.addresses.length;
  await saveScanCache(host);
  await saveHosts({ silent: true });
  const message = `${targetName} 扫描完成：${deviceCount} 个网卡，${addressCount} 个 IP。`;
  if (!quiet) {
    showToast(message, "ok");
  }
  return { host, deviceCount, addressCount };
}

async function startJob(dryRun) {
  const config = collectConfig(dryRun);
  validateOneToOne(config);
  if (!dryRun) await assertNoActiveJob();
  const data = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify(config),
  });
  state.currentJob = data.id;
  state.stopRequested = false;
  setStartButtonLocked(true);
  setStopButtonState(!dryRun);
  delete state.notifiedJobs[data.id];
  localStorage.setItem("roceCurrentJob", data.id);
  state.resultSignature = "";
  state.resultGroups = [];
  state.openResultGroupKey = "";
  $("resultOutput").className = "result-view empty";
  $("resultOutput").textContent = "等待任务输出...";
  updateJobStatusWidget({ id: data.id, status: "queued", logs: ["任务已提交"], results: [] });
  rememberRecentJob({ id: data.id, status: "queued", logs: ["任务已提交"], results: [] });
  pollJob();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollJob, 1000);
}

async function pollJob({ notify = true } = {}) {
  if (!state.currentJob) return;
  let data;
  try {
    data = await api(`/api/jobs/${state.currentJob}?logs=120&results=500`);
  } catch (err) {
    localStorage.removeItem("roceCurrentJob");
    state.currentJob = null;
    setStartButtonLocked(false);
    state.stopRequested = false;
    setStopButtonState(false);
    updateJobStatusWidget();
    return;
  }
  const parsedRows = parseResultLines(data.results || []).rows;
  const isActive = ["queued", "running"].includes(data.status);
  setStartButtonLocked(isActive);
  if (isActive && !state.stopRequested) setStopButtonState(true);
  $("jobOutput").textContent = [`任务 ${data.id} 状态：${statusText(data.status, parsedRows)}`, "", ...displayLogs(data, parsedRows)].join("\n");
  renderResults(data);
  updateJobStatusWidget(data);
  rememberRecentJob(data);
  if (["finished", "failed", "stopped"].includes(data.status)) {
    state.stopRequested = false;
    setStopButtonState(false);
    clearInterval(state.pollTimer);
    if (notify) notifyJobFinished(data);
  }
  return data;
}

async function restoreLatestJob() {
  const savedJobId = localStorage.getItem("roceCurrentJob");
  if (savedJobId) {
    state.currentJob = savedJobId;
    const restored = await pollJob({ notify: false });
    if (restored) {
      if (["queued", "running"].includes(restored.status)) {
        state.stopRequested = false;
        setStartButtonLocked(true);
        setStopButtonState(true);
        clearInterval(state.pollTimer);
        state.pollTimer = setInterval(pollJob, 1000);
      } else {
        setStartButtonLocked(false);
        setStopButtonState(false);
        localStorage.removeItem("roceCurrentJob");
      }
      return;
    }
  }
  const data = await api("/api/jobs");
  if (!data.jobs || !data.jobs.length) {
    setStartButtonLocked(false);
    setStopButtonState(false);
    return;
  }
  const latest = data.jobs[0];
  state.currentJob = latest.id;
  if (["queued", "running"].includes(latest.status)) {
    localStorage.setItem("roceCurrentJob", latest.id);
  } else {
    localStorage.removeItem("roceCurrentJob");
  }
  const latestRows = parseResultLines(latest.results || []).rows;
  $("jobOutput").textContent = [`任务 ${latest.id} 状态：${statusText(latest.status, latestRows)}`, "", ...displayLogs(latest, latestRows)].join("\n");
  renderResults(latest);
  updateJobStatusWidget(latest);
  rememberRecentJob(latest);
  if (["queued", "running"].includes(latest.status)) {
    state.stopRequested = false;
    setStartButtonLocked(true);
    setStopButtonState(true);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollJob, 1000);
  } else {
    setStartButtonLocked(false);
    setStopButtonState(false);
  }
}

function parseResultLines(lines = []) {
  const rows = [];
  const events = [];
  const rowPattern =
    /^\[(?<time>[^\]]+)\]\s+(?<role>SERVER|CLIENT)\s+(?<host>[^:]+):\s+(?<bytes>\d+)\s+(?<iterations>\d+)\s+(?<peak>[0-9.]+)\s+(?<average>[0-9.]+)\s+(?<msgRate>[0-9.]+)\s*$/;
  lines.forEach((line) => {
    const match = line.match(rowPattern);
    if (match && match.groups) {
      rows.push({
        time: match.groups.time,
        role: match.groups.role,
        host: match.groups.host,
        bytes: Number(match.groups.bytes),
        iterations: Number(match.groups.iterations),
        peak: Number(match.groups.peak),
        average: Number(match.groups.average),
        msgRate: Number(match.groups.msgRate),
      });
      return;
    }
    if (
      line.includes("等待 perftest 输出") ||
      line.includes("local address") ||
      line.includes("remote address") ||
      line.includes("RDMA") ||
      line.includes("BW average") ||
      line.includes("MsgRate")
    ) {
      events.push(line);
    }
  });
  return { rows, events };
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function naturalCompare(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

function compareResultGroups(a, b) {
  return naturalCompare(a.host, b.host) || naturalCompare(a.device, b.device);
}

function resultDeviceFor(data, row) {
  const hosts = (data.config && data.config.hosts) || [];
  const host = hosts.find((item) => {
    return [item.name, item.address, item.roceIp].filter(Boolean).some((value) => String(value) === String(row.host));
  });
  return (host && host.device) || "-";
}

function recentJobEndpointText(job, rows) {
  const row = rows.find((item) => item.average > 0) || rows[0];
  if (!row) return "-";
  const device = resultDeviceFor(job, row);
  return [row.host, device].filter((value) => value && value !== "-").join(" / ") || row.host || "-";
}

function groupedResultRows(data, rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const device = resultDeviceFor(data, row);
    const key = `${row.host}@@${device}`;
    if (!groups.has(key)) groups.set(key, { host: row.host, device, rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()]
    .map((group) => {
      const best = Math.max(...group.rows.map((row) => row.average));
      const avg = group.rows.reduce((sum, row) => sum + row.average, 0) / group.rows.length;
      const msgRate = group.rows.reduce((sum, row) => sum + row.msgRate, 0);
      return { ...group, best, avg, msgRate };
    })
    .sort(compareResultGroups);
}

function resultGroupKey(group) {
  return `${group.host}@@${group.device}`;
}

function resultTimeSeconds(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function resultDurationText(rows) {
  const times = rows.map((row) => resultTimeSeconds(row.time)).filter((value) => value !== null);
  if (times.length < 2) return "耗时 <1秒";
  let delta = times[times.length - 1] - times[0];
  if (delta < 0) delta += 24 * 3600;
  if (delta < 60) return `耗时 ${Math.max(1, delta)}秒`;
  const minutes = Math.floor(delta / 60);
  const seconds = delta % 60;
  return `耗时 ${minutes}分${seconds ? `${seconds}秒` : ""}`;
}

function chartSvg(rows) {
  const samples = rows
    .map((row, index) => ({ row, index, value: row.average, rawTime: resultTimeSeconds(row.time) }))
    .filter((item) => Number.isFinite(item.value));
  const values = samples.map((item) => item.value);
  const width = 380;
  const height = 170;
  const left = 62;
  const right = 28;
  const top = 26;
  const bottom = 42;
  if (!values.length) {
    return `<svg class="result-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="暂无带宽曲线"><line class="chart-axis-line" x1="${left}" y1="${height / 2}" x2="${width - right}" y2="${height / 2}"></line></svg>`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const padding = Math.max((max - min) * 0.18, 0.04);
  const yMin = Math.max(0, min - padding);
  const yMax = max + padding;
  const yRange = Math.max(yMax - yMin, 0.01);
  const timedSamples = samples.map((sample) => ({
    ...sample,
    label: sample.row.time || `${sample.index + 1}`,
  }));
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const pointFor = (sample) => {
    const x = timedSamples.length === 1 ? left + plotWidth / 2 : left + (sample.index * plotWidth) / (timedSamples.length - 1);
    const y = top + ((yMax - sample.value) * plotHeight) / yRange;
    return { x, y };
  };
  const points = timedSamples.map(pointFor);
  const linePoints = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPoints = `${left},${(height - bottom).toFixed(1)} ${linePoints} ${points[points.length - 1].x.toFixed(1)},${(height - bottom).toFixed(1)}`;
  const maxIndex = values.indexOf(max);
  const maxPoint = points[maxIndex];
  const latest = values[values.length - 1];
  const latestPoint = points[points.length - 1];
  const visiblePointStep = Math.max(1, Math.ceil(points.length / 18));
  const pointDots = points
    .map((point, index) => {
      if (index !== maxIndex && index !== points.length - 1 && index % visiblePointStep !== 0) return "";
      const tooltipX = Math.min(Math.max(point.x - 42, left + 4), width - right - 88);
      const tooltipY = Math.max(point.y - 38, top + 4);
      return `
        <g class="chart-point">
          <circle class="chart-point-hit" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="11"></circle>
          <circle class="chart-sample-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.2"></circle>
          <g class="chart-tooltip" transform="translate(${tooltipX.toFixed(1)} ${tooltipY.toFixed(1)})">
            <rect width="88" height="30" rx="6"></rect>
            <text x="8" y="12">${escapeHtml(timedSamples[index].label)}</text>
            <text x="8" y="24">${formatNumber(values[index])} Gb/s</text>
          </g>
          <title>${escapeHtml(timedSamples[index].label)} · ${formatNumber(values[index])} Gb/s</title>
        </g>`;
    })
    .join("");
  const avgY = top + ((yMax - avg) * plotHeight) / yRange;
  const yTicks = [yMax, (yMax + yMin) / 2, yMin].map((value) => ({
    value,
    y: top + ((yMax - value) * plotHeight) / yRange,
  }));
  const timeTickIndexes = [...new Set([0, Math.floor((timedSamples.length - 1) / 2), timedSamples.length - 1])];
  const xTicks = timeTickIndexes.map((index) => ({ sample: timedSamples[index], point: points[index], anchor: index === 0 ? "start" : index === timedSamples.length - 1 ? "end" : "middle" }));
  return `
    <svg class="result-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="带宽曲线，单位 Gb/s">
      <title>带宽曲线，单位 Gb/s</title>
      <desc>横轴为采样时间，纵轴为平均带宽。</desc>
      <text class="chart-unit-label" x="${left}" y="15">Gb/s</text>
      ${yTicks
        .map(
          (tick) => `
            <line class="chart-grid-line" x1="${left}" y1="${tick.y.toFixed(1)}" x2="${width - right}" y2="${tick.y.toFixed(1)}"></line>
            <text class="chart-axis-label" x="8" y="${(tick.y + 4).toFixed(1)}">${formatNumber(tick.value)}</text>`
        )
        .join("")}
      ${xTicks
        .map(
          (tick) => `
            <line class="chart-grid-line vertical" x1="${tick.point.x.toFixed(1)}" y1="${top}" x2="${tick.point.x.toFixed(1)}" y2="${height - bottom}"></line>
            <text class="chart-time-label" text-anchor="${tick.anchor}" x="${tick.point.x.toFixed(1)}" y="${height - 8}">${escapeHtml(tick.sample.label)}</text>`
        )
        .join("")}
      <line class="chart-axis-line" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"></line>
      <line class="chart-axis-line" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"></line>
      <line class="chart-average-line" x1="${left}" y1="${avgY.toFixed(1)}" x2="${width - right}" y2="${avgY.toFixed(1)}"></line>
      <polygon class="chart-area" points="${areaPoints}"></polygon>
      <polyline points="${linePoints}"></polyline>
      ${pointDots}
      <circle class="chart-peak" cx="${maxPoint.x.toFixed(1)}" cy="${maxPoint.y.toFixed(1)}" r="4"></circle>
      <circle class="chart-latest-halo" cx="${latestPoint.x.toFixed(1)}" cy="${latestPoint.y.toFixed(1)}" r="6"></circle>
      <circle class="chart-latest" cx="${latestPoint.x.toFixed(1)}" cy="${latestPoint.y.toFixed(1)}" r="3.4"></circle>
    </svg>`;
}

function resultDetailTableHtml(group) {
  return `
    <div class="result-table-wrap">
      <table class="result-table">
        <thead>
          <tr>
            <th>方向</th>
            <th>包大小</th>
            <th>迭代</th>
            <th>峰值 Gb/s</th>
            <th>平均 Gb/s</th>
            <th>Mpps</th>
          </tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              (row) => `
                <tr>
                  <td><span class="role-chip ${row.role.toLowerCase()}">${row.role}</span></td>
                  <td>${row.bytes.toLocaleString()}</td>
                  <td>${row.iterations.toLocaleString()}</td>
                  <td>${formatNumber(row.peak)}</td>
                  <td class="strong-cell">${formatNumber(row.average)}</td>
                  <td>${formatNumber(row.msgRate, 3)}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function resultGroupsHtml(data, rows, emptyText) {
  if (!rows.length) return `<div class="result-placeholder">${escapeHtml(emptyText)}</div>`;
  state.resultGroups = groupedResultRows(data, rows);
  return `<div class="result-chart-grid">${state.resultGroups
    .map(
      (group, index) => `
        <button class="result-chart-card" data-result-group="${index}" data-result-key="${escapeHtml(resultGroupKey(group))}" type="button">
          <div class="result-chart-head">
            <div>
              <strong>${escapeHtml(group.host)}</strong>
              <span>${escapeHtml(group.device)}</span>
            </div>
            <em>${formatNumber(group.best)} Gb/s</em>
          </div>
          ${chartSvg(group.rows)}
          <div class="result-chart-meta">
            <span>${escapeHtml(resultDurationText(group.rows))}</span>
            <span>平均 ${formatNumber(group.avg)} Gb/s</span>
            <span>${formatNumber(group.msgRate, 3)} Mpps</span>
          </div>
        </button>`
    )
    .join("")}</div>`;
}

function ensureResultDetailModal() {
  let modal = document.getElementById("resultDetailModal");
  if (modal) return modal;
  modal = document.createElement("section");
  modal.id = "resultDetailModal";
  modal.className = "history-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="history-modal-backdrop" data-result-detail-close></div>
    <div class="result-detail-panel">
      <div class="history-modal-head">
        <div>
          <h2 id="resultDetailTitle">结果详情</h2>
          <p id="resultDetailMeta"></p>
        </div>
        <button id="closeResultDetail" type="button">关闭</button>
      </div>
      <div id="resultDetailBody" class="result-detail-body"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("#closeResultDetail").addEventListener("click", closeResultDetail);
  modal.querySelectorAll("[data-result-detail-close]").forEach((item) => item.addEventListener("click", closeResultDetail));
  return modal;
}

function openResultDetail(group) {
  const modal = ensureResultDetailModal();
  state.openResultGroupKey = resultGroupKey(group);
  $("resultDetailTitle").textContent = `${group.host} · ${group.device}`;
  $("resultDetailMeta").textContent = `${resultDurationText(group.rows)} · 平均 ${formatNumber(group.avg)} Gb/s · 最佳 ${formatNumber(group.best)} Gb/s`;
  $("resultDetailBody").innerHTML = resultDetailTableHtml(group);
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function refreshOpenResultDetail() {
  if (!state.openResultGroupKey) return;
  const modal = document.getElementById("resultDetailModal");
  if (!modal || modal.hidden) return;
  const group = state.resultGroups.find((item) => resultGroupKey(item) === state.openResultGroupKey);
  if (!group) return;
  $("resultDetailTitle").textContent = `${group.host} · ${group.device}`;
  $("resultDetailMeta").textContent = `${resultDurationText(group.rows)} · 平均 ${formatNumber(group.avg)} Gb/s · 最佳 ${formatNumber(group.best)} Gb/s`;
  $("resultDetailBody").innerHTML = resultDetailTableHtml(group);
}

function closeResultDetail() {
  const modal = document.getElementById("resultDetailModal");
  if (modal) modal.hidden = true;
  state.openResultGroupKey = "";
  document.body.classList.remove("modal-open");
}

function bindResultGroupClicks() {
  document.querySelectorAll("[data-result-group]").forEach((item) => {
    item.addEventListener("click", () => {
      const group = state.resultGroups[Number(item.dataset.resultGroup)];
      if (group) openResultDetail(group);
    });
  });
}

function inferFailureReason(data, rows) {
  const logs = [...(data.logs || []), ...(data.results || [])].join("\n");
  if (rows.length) return "已有有效打流结果";
  if (logs.includes("Permission denied") || logs.includes("认证失败") || logs.includes("密码认证失败")) {
    return "SSH 认证失败，请检查用户名、密码、端口或目标机是否允许密码登录";
  }
  if (logs.includes("Connection refused") || logs.includes("connect to host")) {
    return "SSH 连接被拒绝，请检查 SSH 端口、服务状态或防火墙";
  }
  if (logs.includes("timed out") || logs.includes("超时") || logs.includes("No route to host")) {
    return "连接超时或路由不可达，请检查网络连通性和目标地址";
  }
  if (logs.includes("手动停止前未收到任何 perftest 结果")) {
    return "手动停止太早，未收到任何 perftest 结果";
  }
  if (logs.includes("server 启动失败")) {
    return "server 端启动失败，请检查网卡名、RoCE IP、端口占用和 perftest 环境";
  }
  if (logs.includes("client 执行失败")) {
    return "client 端执行失败，请检查目标 RoCE IP、路由、网卡选择和 GID/端口参数";
  }
  if (logs.includes("ib_write") || logs.includes("ib_read") || logs.includes("ib_send")) {
    return "perftest 执行异常，请查看任务日志中的具体输出";
  }
  return "未识别到明确原因，请查看任务日志";
}

function notifyJobFinished(data) {
  if (state.notifiedJobs[data.id]) return;
  state.notifiedJobs[data.id] = true;
  const { rows } = parseResultLines(data.results || []);
  if (data.status === "finished") {
    showToast(`测试成功：收到 ${rows.length} 条结果。`, "ok", 6200);
    return;
  }
  if (data.status === "stopped" && rows.length) {
    showToast(`测试完成：已收到 ${rows.length} 条结果，扫描结束。`, "ok", 7000);
    return;
  }
  const reason = inferFailureReason(data, rows);
  showToast(`测试失败：${reason}`, "bad", 9000);
}

function renderResults(data) {
  const isActive = ["queued", "running"].includes(data.status);
  const now = Date.now();
  if (isActive && state.resultSignature && now - state.lastResultRenderAt < 1800) {
    state.pendingResultData = data;
    if (!state.resultRenderTimer) {
      state.resultRenderTimer = setTimeout(() => {
        const pending = state.pendingResultData;
        state.pendingResultData = null;
        state.resultRenderTimer = null;
        if (pending) renderResults(pending);
      }, 1800 - (now - state.lastResultRenderAt));
    }
    return;
  }
  if (!isActive && state.resultRenderTimer) {
    clearTimeout(state.resultRenderTimer);
    state.resultRenderTimer = null;
    state.pendingResultData = null;
  }

  const box = $("resultOutput");
  const lines = data.results || [];
  if (!lines.length) {
    state.resultSignature = "";
    state.resultGroups = [];
    box.className = "result-view empty";
    box.textContent = "暂未收到 perftest 输出。";
    return;
  }
  const signature = [data.id, data.status, lines.length, lines[lines.length - 1] || ""].join("|");
  if (signature === state.resultSignature && box.classList.contains("result-view") && !box.classList.contains("empty")) {
    refreshOpenResultDetail();
    return;
  }

  const { rows, events } = parseResultLines(lines);
  const bestAverage = rows.length ? Math.max(...rows.map((row) => row.average)) : 0;
  const avgBandwidth = rows.length ? rows.reduce((sum, row) => sum + row.average, 0) / rows.length : 0;
  const totalMsgRate = rows.reduce((sum, row) => sum + row.msgRate, 0);
  const statusClass = data.status === "finished" || (data.status === "stopped" && rows.length) ? "ok" : data.status === "failed" ? "bad" : "live";
  const displayStatusText = statusText(data.status, rows);
  const previousScrollTop = box.scrollTop;

  box.className = "result-view";
  box.innerHTML = `
    <div class="result-summary">
      <div class="metric-card">
        <span>任务状态</span>
        <strong class="status-pill ${statusClass}">${displayStatusText}</strong>
      </div>
      <div class="metric-card">
        <span>平均带宽</span>
        <strong>${formatNumber(avgBandwidth)} Gb/s</strong>
      </div>
      <div class="metric-card">
        <span>最佳带宽</span>
        <strong>${formatNumber(bestAverage)} Gb/s</strong>
      </div>
      <div class="metric-card">
        <span>消息速率</span>
        <strong>${formatNumber(totalMsgRate, 3)} Mpps</strong>
      </div>
    </div>
    ${resultGroupsHtml(data, rows, "已连接，等待 perftest 结果表输出...")}
    <details class="raw-results">
      <summary>原始输出</summary>
      <pre>${isActive ? "任务运行中，原始输出会在任务完成后显示。实时过程请看任务日志。" : escapeHtml(lines.join("\n"))}</pre>
    </details>
    ${
      events.length
        ? `<div class="result-events">${events
            .slice(-6)
            .map((event) => `<div>${escapeHtml(event.replace(/^\[[^\]]+\]\s+/, ""))}</div>`)
            .join("")}</div>`
        : ""
    }
  `;
  box.scrollTop = previousScrollTop;
  state.resultSignature = signature;
  state.lastResultRenderAt = Date.now();
  bindResultGroupClicks();
  refreshOpenResultDetail();
}

async function stopJob() {
  if (!state.currentJob || state.stopRequested) return;
  state.stopRequested = true;
  setStopButtonState(true, true);
  try {
    await api(`/api/jobs/${state.currentJob}/stop`, { method: "POST", body: "{}" });
    pollJob();
  } catch (err) {
    state.stopRequested = false;
    setStopButtonState(true);
    throw err;
  }
}

$("runReal").addEventListener("click", () =>
  startJob(false).catch((err) => {
    $("jobOutput").textContent = err.message;
    showToast(err.message, "bad", 7000);
  })
);
$("stopJob").addEventListener("click", () => stopJob().catch((err) => showToast(`停止失败：${err.message}`, "bad", 7000)));
$("toggleJobWidget").addEventListener("click", () => {
  setJobWidgetCollapsed(!$("jobStatusWidget").classList.contains("collapsed"));
});
$("showAdvancedRole").addEventListener("change", (event) => {
  document.body.classList.toggle("show-advanced-role", event.target.checked);
});
$("roleSearch").addEventListener("input", (event) => {
  state.roleSearch = event.target.value;
  state.rolePage = 1;
  renderHosts();
});
$("rolePageSize").addEventListener("change", (event) => {
  state.rolePageSize = Number(event.target.value);
  state.rolePage = 1;
  renderHosts();
});
$("bulkDeviceSelect").addEventListener("change", (event) => {
  const device = event.target.value;
  applyBulkDevice(device).catch((err) => showToast(`批量选择失败：${err.message}`, "bad", 7000));
});
$("rolePrevPage").addEventListener("click", () => {
  state.rolePage -= 1;
  renderHosts();
});
$("roleNextPage").addEventListener("click", () => {
  state.rolePage += 1;
  renderHosts();
});
document.querySelectorAll("[data-role-filter]").forEach((item) => {
  item.addEventListener("click", () => {
    const nextFilter = item.dataset.roleFilter || "";
    state.roleFilter = state.roleFilter === nextFilter ? "" : nextFilter;
    state.rolePage = 1;
    renderHosts();
  });
});
window.addEventListener("beforeunload", flushRoleSave);

loadRoleViewState();
setJobWidgetCollapsed(localStorage.getItem(JOB_WIDGET_COLLAPSED_KEY) === "1");
$("roleSearch").value = state.roleSearch;
$("rolePageSize").value = String(state.rolePageSize);
loadHosts();
loadRecentJobs().catch(() => renderRecentJobs());
restoreLatestJob().catch(() => {});
