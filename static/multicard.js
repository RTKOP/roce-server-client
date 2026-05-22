const state = {
  hosts: [],
  selected: { server: new Set(), client: new Set() },
  currentJob: null,
  pollTimer: null,
  toastTimer: null,
  resultSignature: "",
  resultGroups: [],
  openResultGroupKey: "",
  stopRequested: false,
};

const $ = (id) => document.getElementById(id);

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(message, type = "info", timeout = 3600) {
  const toast = $("toast");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  if (timeout) state.toastTimer = setTimeout(() => (toast.hidden = true), timeout);
}

function setStopButtonState(active, stopping = false) {
  const button = $("stopJob");
  if (!button) return;
  button.disabled = !active || stopping;
  button.textContent = stopping ? "停止中..." : "停止";
}

function hostLabel(host) {
  return host ? host.name || host.address || "未命名服务器" : "未选择";
}

function normalizeHost(host, index) {
  if (!host.id) host.id = crypto.randomUUID();
  if (!host.name) host.name = host.address || `host-${index + 1}`;
  if (!host.sshPort) host.sshPort = "22";
  if (!host.sshUser) host.sshUser = "root";
  if (!host.role || host.role === "disabled") host.role = "client";
  return host;
}

function nicEndpoints(host) {
  if (!host) return [];
  const rows = [];
  (host.scanDevices || []).forEach((item) => {
    (item.addresses || []).filter(Boolean).forEach((address) => {
      rows.push({
        key: `${item.device || ""}@@${address}`,
        device: item.device || "",
        netdev: item.netdev || "",
        roceIp: address,
        label: [item.device, item.netdev, address].filter(Boolean).join(" / "),
      });
    });
  });
  if (!rows.length && host.device && host.roceIp) {
    rows.push({
      key: `${host.device}@@${host.roceIp}`,
      device: host.device,
      netdev: "",
      roceIp: host.roceIp,
      label: [host.device, host.roceIp].filter(Boolean).join(" / "),
    });
  }
  return rows;
}

function selectedHost(side) {
  return state.hosts.find((host) => String(host.id) === String($(side === "server" ? "serverHost" : "clientHost").value));
}

function renderHostSelects() {
  const enabled = state.hosts.filter((host) => host.enabled !== false);
  const options = ['<option value="">选择服务器</option>']
    .concat(enabled.map((host) => `<option value="${escapeHtml(host.id)}">${escapeHtml(hostLabel(host))} · ${escapeHtml(host.address || "")}</option>`))
    .join("");
  $("serverHost").innerHTML = options;
  $("clientHost").innerHTML = options;
}

function renderSide(side) {
  const host = selectedHost(side);
  const box = $(side === "server" ? "serverCards" : "clientCards");
  const selected = state.selected[side];
  const endpoints = nicEndpoints(host);
  selected.forEach((key) => {
    if (!endpoints.some((item) => item.key === key)) selected.delete(key);
  });
  if (!host) {
    box.className = "nic-grid empty";
    box.textContent = `请选择 ${side === "server" ? "Server" : "Client"} 机器。`;
    return;
  }
  if (!endpoints.length) {
    box.className = "nic-grid empty";
    box.innerHTML = `没有可用网卡/IP，请先扫描 ${escapeHtml(hostLabel(host))}。`;
    return;
  }
  box.className = "nic-grid";
  box.innerHTML = endpoints
    .map(
      (endpoint) => `
        <label class="nic-card ${selected.has(endpoint.key) ? "selected" : ""}">
          <input type="checkbox" data-nic-side="${side}" data-nic-key="${escapeHtml(endpoint.key)}" ${selected.has(endpoint.key) ? "checked" : ""}>
          <span>${escapeHtml(endpoint.device)}</span>
          <strong>${escapeHtml(endpoint.netdev || "RoCE")}</strong>
          <em>${escapeHtml(endpoint.roceIp)}</em>
        </label>`
    )
    .join("");
}

function endpointByKey(host, key) {
  return nicEndpoints(host).find((item) => item.key === key);
}

function selectedEndpoints(side) {
  const host = selectedHost(side);
  return [...state.selected[side]].map((key) => endpointByKey(host, key)).filter(Boolean);
}

function renderPairs() {
  const serverHost = selectedHost("server");
  const clientHost = selectedHost("client");
  const servers = selectedEndpoints("server");
  const clients = selectedEndpoints("client");
  $("serverCardCount").textContent = `Server ${servers.length}`;
  $("clientCardCount").textContent = `Client ${clients.length}`;
  $("pairCount").textContent = `${Math.min(servers.length, clients.length)} 对网卡`;
  const box = $("pairList");
  if (!servers.length || !clients.length) {
    $("pairHint").textContent = "两侧选择相同数量的网卡后即可开始。";
    box.className = "pair-list empty";
    box.textContent = "暂无配对。";
    return;
  }
  const ok = servers.length === clients.length;
  $("pairHint").textContent = ok ? "将按当前顺序严格 1 对 1 启动。" : "两侧网卡数量不一致，请调整后再开始。";
  box.className = "pair-list";
  const count = Math.max(servers.length, clients.length);
  box.innerHTML = Array.from({ length: count })
    .map((_, index) => {
      const server = servers[index];
      const client = clients[index];
      return `
        <div class="pair-row ${server && client ? "" : "bad"}">
          <span>流 ${index + 1}</span>
          <strong>${escapeHtml(client ? `${hostLabel(clientHost)} / ${client.device} / ${client.roceIp}` : "缺少 client 网卡")}</strong>
          <i>→</i>
          <strong>${escapeHtml(server ? `${hostLabel(serverHost)} / ${server.device} / ${server.roceIp}` : "缺少 server 网卡")}</strong>
        </div>`;
    })
    .join("");
}

function renderAll() {
  renderSide("server");
  renderSide("client");
  renderPairs();
}

async function loadHosts() {
  const data = await api("/api/hosts");
  state.hosts = (data.hosts || []).map(normalizeHost);
  renderHostSelects();
  renderAll();
}

async function saveScanCache(host) {
  await api("/api/hosts/scan-cache", {
    method: "POST",
    body: JSON.stringify({
      hostId: host.id,
      scanDevices: host.scanDevices || [],
      scanAddresses: host.scanAddresses || [],
      device: host.device || "",
      roceIp: host.roceIp || "",
    }),
  });
}

async function scanSelectedHost(side) {
  const host = selectedHost(side);
  if (!host) throw new Error(`请先选择 ${side === "server" ? "Server" : "Client"} 机器`);
  showToast(`正在扫描 ${hostLabel(host)}...`, "info", 0);
  const data = await api("/api/hosts/scan", {
    method: "POST",
    body: JSON.stringify({ hostId: host.id, host }),
  });
  host.scanDevices = data.devices || [];
  host.scanAddresses = data.addresses || [];
  const first = host.scanDevices.find((item) => item.addresses && item.addresses.length);
  if (first) {
    host.device = first.device || host.device;
    host.roceIp = first.addresses[0] || host.roceIp;
  }
  await saveScanCache(host);
  state.selected[side].clear();
  renderAll();
  showToast(`${hostLabel(host)} 扫描完成`, "ok");
}

function collectConfig() {
  const serverHost = selectedHost("server");
  const clientHost = selectedHost("client");
  const servers = selectedEndpoints("server");
  const clients = selectedEndpoints("client");
  if (!serverHost) throw new Error("请选择 Server 机器");
  if (!clientHost) throw new Error("请选择 Client 机器");
  if (!servers.length || !clients.length) throw new Error("请至少选择一对网卡");
  if (servers.length !== clients.length) throw new Error("Server 和 Client 网卡数量必须一致，才能严格 1 对 1");

  const serverKeys = new Set();
  const clientKeys = new Set();
  const hosts = [];
  servers.forEach((server, index) => {
    const client = clients[index];
    const serverKey = `${serverHost.address}|${server.device}`;
    const clientKey = `${clientHost.address}|${client.device}`;
    if (serverKeys.has(serverKey)) throw new Error(`server 网卡重复：${server.device}`);
    if (clientKeys.has(clientKey)) throw new Error(`client 网卡重复：${client.device}`);
    if (serverKey === clientKey) throw new Error(`同一个端点不能同时作为 client 和 server：${server.device}`);
    serverKeys.add(serverKey);
    clientKeys.add(clientKey);

    const serverId = `mc-server-${serverHost.id}-${index}`;
    hosts.push({
      ...serverHost,
      id: serverId,
      name: `${hostLabel(serverHost)}-${server.device}`,
      role: "server",
      enabled: true,
      device: server.device,
      roceIp: server.roceIp,
      targetServerId: "",
      gidIndex: "",
      port: "",
    });
    hosts.push({
      ...clientHost,
      id: `mc-client-${clientHost.id}-${index}`,
      name: `${hostLabel(clientHost)}-${client.device}`,
      role: "client",
      enabled: true,
      device: client.device,
      roceIp: client.roceIp,
      targetServerId: serverId,
      gidIndex: "",
      port: "",
    });
  });

  return {
    dryRun: false,
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

function statusText(status, rows = []) {
  return {
    queued: "排队中",
    running: "运行中",
    finished: "已完成",
    stopped: rows.length ? "已完成" : "已完成",
    failed: "失败",
  }[status] || "未知";
}

function parseResultLines(lines = []) {
  const rows = [];
  const pattern = /^\[(?<time>[^\]]+)\]\s+(?<role>SERVER|CLIENT)\s+(?<host>[^:]+):\s+(?<bytes>\d+)\s+(?<iterations>\d+)\s+(?<peak>[0-9.]+)\s+(?<average>[0-9.]+)\s+(?<msgRate>[0-9.]+)\s*$/;
  lines.forEach((line) => {
    const match = line.match(pattern);
    if (!match || !match.groups) return;
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
  });
  return rows;
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
  const host = hosts.find((item) => [item.name, item.address, item.roceIp].filter(Boolean).some((value) => String(value) === String(row.host)));
  return (host && host.device) || "-";
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
        <thead><tr><th>方向</th><th>包大小</th><th>迭代</th><th>峰值 Gb/s</th><th>平均 Gb/s</th><th>Mpps</th></tr></thead>
        <tbody>${group.rows
          .map(
            (row) => `<tr><td><span class="role-chip ${row.role.toLowerCase()}">${row.role}</span></td><td>${row.bytes.toLocaleString()}</td><td>${row.iterations.toLocaleString()}</td><td>${formatNumber(row.peak)}</td><td class="strong-cell">${formatNumber(row.average)}</td><td>${formatNumber(row.msgRate, 3)}</td></tr>`
          )
          .join("")}</tbody>
      </table>
    </div>`;
}

function resultGroupsHtml(data, rows, emptyText) {
  if (!rows.length) return `<div class="result-placeholder">${escapeHtml(emptyText)}</div>`;
  state.resultGroups = groupedResultRows(data, rows);
  return `<div class="result-chart-grid">${state.resultGroups
    .map(
      (group, index) => `
        <button class="result-chart-card" data-result-group="${index}" type="button">
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

function renderResults(data) {
  const box = $("resultOutput");
  const lines = data.results || [];
  const signature = [data.id, data.status, lines.length, lines[lines.length - 1] || ""].join("|");
  if (signature === state.resultSignature) return;
  state.resultSignature = signature;
  if (!lines.length) {
    state.resultGroups = [];
    box.className = "result-view empty";
    box.textContent = "暂未收到 perftest 输出。";
    return;
  }
  const rows = parseResultLines(lines);
  const best = rows.length ? Math.max(...rows.map((row) => row.average)) : 0;
  const avg = rows.length ? rows.reduce((sum, row) => sum + row.average, 0) / rows.length : 0;
  const mpps = rows.reduce((sum, row) => sum + row.msgRate, 0);
  box.className = "result-view";
  box.innerHTML = `
    <div class="result-summary">
      <div class="metric-card"><span>任务状态</span><strong class="status-pill ${data.status === "failed" ? "bad" : "ok"}">${statusText(data.status, rows)}</strong></div>
      <div class="metric-card"><span>平均带宽</span><strong>${formatNumber(avg)} Gb/s</strong></div>
      <div class="metric-card"><span>最佳带宽</span><strong>${formatNumber(best)} Gb/s</strong></div>
      <div class="metric-card"><span>消息速率</span><strong>${formatNumber(mpps, 3)} Mpps</strong></div>
    </div>
    ${resultGroupsHtml(data, rows, "已连接，等待 perftest 结果表输出...")}
    <details class="raw-results"><summary>原始输出</summary><pre>${escapeHtml(lines.join("\n"))}</pre></details>`;
  bindResultGroupClicks();
  refreshOpenResultDetail();
}

async function assertNoActiveJob() {
  const data = await api("/api/jobs");
  const active = (data.jobs || []).find((job) => ["queued", "running"].includes(job.status));
  if (active) throw new Error(`已有任务正在运行：${active.id}，请先停止或等待完成`);
}

async function startJob() {
  const config = collectConfig();
  await assertNoActiveJob();
  const data = await api("/api/jobs", { method: "POST", body: JSON.stringify(config) });
  state.currentJob = data.id;
  state.stopRequested = false;
  localStorage.setItem("roceCurrentJob", data.id);
  $("runMulti").disabled = true;
  $("runMulti").textContent = "任务运行中";
  setStopButtonState(true);
  $("jobOutput").textContent = `任务 ${data.id} 已提交`;
  state.resultSignature = "";
  pollJob();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollJob, 1000);
}

async function pollJob() {
  if (!state.currentJob) return;
  const data = await api(`/api/jobs/${state.currentJob}?logs=80&results=420`);
  const rows = parseResultLines(data.results || []);
  $("jobOutput").textContent = [`任务 ${data.id} 状态：${statusText(data.status, rows)}`, "", ...(data.logs || []).slice(-80)].join("\n");
  renderResults(data);
  if (["queued", "running"].includes(data.status) && !state.stopRequested) {
    setStopButtonState(true);
  }
  if (["finished", "failed", "stopped"].includes(data.status)) {
    clearInterval(state.pollTimer);
    $("runMulti").disabled = false;
    $("runMulti").textContent = "开始多卡测试！";
    state.stopRequested = false;
    setStopButtonState(false);
  }
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

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "serverHost") {
    state.selected.server.clear();
    renderAll();
  }
  if (target.id === "clientHost") {
    state.selected.client.clear();
    renderAll();
  }
  if (target.dataset && target.dataset.nicSide) {
    const set = state.selected[target.dataset.nicSide];
    if (target.checked) set.add(target.dataset.nicKey);
    else set.delete(target.dataset.nicKey);
    renderAll();
  }
});

$("scanServer").addEventListener("click", () => scanSelectedHost("server").catch((err) => showToast(`扫描失败：${err.message}`, "bad", 7000)));
$("scanClient").addEventListener("click", () => scanSelectedHost("client").catch((err) => showToast(`扫描失败：${err.message}`, "bad", 7000)));
$("selectAllServers").addEventListener("click", () => {
  nicEndpoints(selectedHost("server")).forEach((item) => state.selected.server.add(item.key));
  renderAll();
});
$("selectAllClients").addEventListener("click", () => {
  nicEndpoints(selectedHost("client")).forEach((item) => state.selected.client.add(item.key));
  renderAll();
});
$("clearServers").addEventListener("click", () => {
  state.selected.server.clear();
  renderAll();
});
$("clearClients").addEventListener("click", () => {
  state.selected.client.clear();
  renderAll();
});
$("runMulti").addEventListener("click", () => startJob().catch((err) => showToast(err.message, "bad", 7000)));
$("stopJob").addEventListener("click", () => stopJob().catch((err) => showToast(`停止失败：${err.message}`, "bad", 7000)));

loadHosts().catch((err) => showToast(`加载服务器失败：${err.message}`, "bad", 9000));
