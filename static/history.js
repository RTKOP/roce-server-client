const state = {
  jobs: [],
  search: "",
  status: "",
  toastTimer: null,
  initialJobId: new URLSearchParams(window.location.search).get("job") || "",
  resultGroups: [],
  selectedIds: new Set(),
  viewedJobId: "",
  refreshTimer: null,
  historySignature: "",
  detailSignature: "",
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
  if (timeout) {
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, timeout);
  }
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

function resultDeviceFor(job, row) {
  const hosts = (job.config && job.config.hosts) || [];
  const host = hosts.find((item) => {
    return [item.name, item.address, item.roceIp].filter(Boolean).some((value) => String(value) === String(row.host));
  });
  return (host && host.device) || "-";
}

function groupedResultRows(job, rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const device = resultDeviceFor(job, row);
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

function resultGroupsHtml(job, rows, emptyText) {
  if (!rows.length) return `<div class="result-placeholder">${escapeHtml(emptyText)}</div>`;
  state.resultGroups = groupedResultRows(job, rows);
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

function openResultDetail(group) {
  $("historyModalTitle").textContent = `${group.host} · ${group.device}`;
  $("historyModalMeta").textContent = `${resultDurationText(group.rows)} · 平均 ${formatNumber(group.avg)} Gb/s · 最佳 ${formatNumber(group.best)} Gb/s`;
  $("historyResult").innerHTML = resultDetailTableHtml(group);
  $("historyResult").className = "result-view";
}

function bindResultGroupClicks() {
  document.querySelectorAll("[data-result-group]").forEach((item) => {
    item.addEventListener("click", () => {
      const group = state.resultGroups[Number(item.dataset.resultGroup)];
      if (group) openResultDetail(group);
    });
  });
}

function formatDateTime(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function jobStatusText(status, rows = []) {
  const labels = {
    queued: "排队中",
    running: "运行中",
    finished: "完成",
    failed: "失败",
    stopped: "完成",
  };
  return labels[status] || status || "-";
}

function displayLogs(job, rows = parseResultLines(job.results || []).rows) {
  const logs = job.logs || [];
  if (job.status === "stopped" && rows.length) {
    return logs.filter((line) => !line.includes("停止失败"));
  }
  return logs;
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

function jobStatusClass(status, rows = []) {
  if (status === "finished" || (status === "stopped" && rows.length)) return "ok";
  if (status === "stopped") return "ok";
  if (status === "failed") return "bad";
  return "live";
}

function jobFilterStatus(job, rows = []) {
  if (job.status === "stopped") return "finished";
  return job.status || "";
}

function historyParticipants(job, parsed = parseResultLines(job.results || [])) {
  const hosts = (job.config && job.config.hosts) || [];
  const resultHosts = new Set(parsed.rows.map((row) => row.host));
  if (resultHosts.size) {
    return hosts.filter((host) => {
      return resultHosts.has(host.name) || resultHosts.has(host.address) || resultHosts.has(host.roceIp);
    });
  }
  return hosts.filter((host) => host.enabled !== false && host.role !== "disabled");
}

function historyMatches(job) {
  const parsed = parseResultLines(job.results || []);
  if (state.status && jobFilterStatus(job, parsed.rows) !== state.status) return false;
  const keyword = state.search.trim().toLowerCase();
  if (!keyword) return true;
  const hosts = historyParticipants(job, parsed);
  const haystack = [
    job.id,
    job.status,
    jobStatusText(job.status, parsed.rows),
    job.config && job.config.testType,
    ...hosts.flatMap((host) => [
      host.name,
      host.address,
      host.roceIp,
      host.device,
      host.role,
      host.sshUser,
      host.targetServerName,
    ]),
    ...parsed.rows.flatMap((row) => [row.host, row.role, row.average, row.peak]),
    ...(job.logs || []),
    ...(job.results || []),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(keyword);
}

function renderHistory() {
  const list = $("historyList");
  state.selectedIds.forEach((id) => {
    if (!state.jobs.some((job) => job.id === id)) state.selectedIds.delete(id);
  });
  const jobs = state.jobs.filter(historyMatches);
  $("historyCount").textContent = `共 ${state.jobs.length} 条，当前 ${jobs.length} 条`;
  if (!jobs.length) {
    $("deleteFilteredHistory").disabled = state.selectedIds.size === 0;
    list.innerHTML = `<div class="history-empty">没有匹配的历史记录。</div>`;
    return;
  }
  list.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th class="history-check-col"><input id="toggleHistorySelected" type="checkbox" title="全选/取消当前列表" /></th>
          <th>时间</th>
          <th>任务</th>
          <th>状态</th>
          <th>结果</th>
          <th>摘要</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(historyRow).join("")}
      </tbody>
    </table>`;
  const toggle = $("toggleHistorySelected");
  syncHistorySelectionState(jobs);
  toggle.addEventListener("change", (event) => {
    jobs.forEach((job) => {
      if (event.target.checked) state.selectedIds.add(job.id);
      else state.selectedIds.delete(job.id);
    });
    list.querySelectorAll("[data-select-job-id]").forEach((checkbox) => {
      checkbox.checked = event.target.checked;
    });
    syncHistorySelectionState(jobs);
  });
  list.querySelectorAll("[data-select-job-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedIds.add(checkbox.dataset.selectJobId);
      else state.selectedIds.delete(checkbox.dataset.selectJobId);
      syncHistorySelectionState(jobs);
    });
  });
  list.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () => viewJob(button.dataset.jobId));
  });
  list.querySelectorAll("[data-delete-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteHistoryJobs([button.dataset.deleteJobId]).catch((err) => showToast(`删除失败：${err.message}`, "bad"));
    });
  });
  list.querySelectorAll("[data-rerun-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      rerunHistoryJob(button.dataset.rerunJobId).catch((err) => showToast(`重测失败：${err.message}`, "bad", 7000));
    });
  });
  list.querySelectorAll("[data-stop-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "停止中";
      stopHistoryJob(button.dataset.stopJobId).catch((err) => {
        renderHistory();
        showToast(`停止失败：${err.message}`, "bad", 7000);
      });
    });
  });
}

function syncHistorySelectionState(jobs = state.jobs.filter(historyMatches)) {
  state.selectedIds.forEach((id) => {
    if (!state.jobs.some((job) => job.id === id)) state.selectedIds.delete(id);
  });
  $("deleteFilteredHistory").disabled = state.selectedIds.size === 0;
  const toggle = $("toggleHistorySelected");
  if (!toggle) return;
  const selectedInView = jobs.filter((job) => state.selectedIds.has(job.id)).length;
  toggle.checked = jobs.length > 0 && selectedInView === jobs.length;
  toggle.indeterminate = selectedInView > 0 && selectedInView < jobs.length;
}

function historyDataSignature(jobs) {
  return jobs
    .map((job) => {
      const logs = job.logs || [];
      const results = job.results || [];
      return [job.id, job.status, job.createdAt, logs.length, logs[logs.length - 1] || "", results.length, results[results.length - 1] || ""].join("|");
    })
    .join("\n");
}

function jobDetailSignature(job) {
  const logs = job.logs || [];
  const results = job.results || [];
  return [job.id, job.status, logs.length, logs[logs.length - 1] || "", results.length, results[results.length - 1] || ""].join("|");
}

function historyRow(job) {
  const parsed = parseResultLines(job.results || []);
  const best = parsed.rows.length ? Math.max(...parsed.rows.map((row) => row.average)) : 0;
  const hosts = historyParticipants(job, parsed);
  const active = ["queued", "running"].includes(job.status);
  const hostNames = hosts
    .slice(0, 4)
    .map((host) => {
      const name = host.name || host.roceIp || host.address;
      return host.device ? `${name}(${host.device})` : name;
    })
    .filter(Boolean)
    .join("，");
  const moreText = hosts.length > 4 ? `等 ${hosts.length} 台` : `${hosts.length} 台`;
  return `
    <tr>
      <td class="history-check-col"><input data-select-job-id="${escapeHtml(job.id)}" type="checkbox" ${state.selectedIds.has(job.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(formatDateTime(job.createdAt))}</td>
      <td><div class="history-id">${escapeHtml(job.id)}</div></td>
      <td><span class="history-status ${jobStatusClass(job.status, parsed.rows)}">${escapeHtml(jobStatusText(job.status, parsed.rows))}</span></td>
      <td>
        <div class="history-result-main">${parsed.rows.length ? `${formatNumber(best)} Gb/s` : "-"}</div>
        <div class="history-type">${parsed.rows.length} 条结果</div>
      </td>
      <td>
        <div class="history-summary">${escapeHtml(hostNames || "未记录服务器")}</div>
        <div class="history-type">${escapeHtml(moreText)} · ${escapeHtml((job.config && job.config.testType) || "perftest")}</div>
      </td>
      <td>
        <div class="history-actions">
          <button class="history-view" data-job-id="${escapeHtml(job.id)}" type="button">查看</button>
          ${active ? `<button class="history-stop" data-stop-job-id="${escapeHtml(job.id)}" type="button">停止</button>` : ""}
          <button class="history-rerun" data-rerun-job-id="${escapeHtml(job.id)}" type="button">重测</button>
          <button class="history-delete" data-delete-job-id="${escapeHtml(job.id)}" type="button">删除</button>
        </div>
      </td>
    </tr>`;
}

async function stopHistoryJob(jobId) {
  if (!jobId) return;
  await api(`/api/jobs/${jobId}/stop`, { method: "POST", body: "{}" });
  showToast(`已发送停止请求：${jobId}`, "ok", 3200);
  await loadHistory();
  if (state.initialJobId === jobId) {
    await viewJob(jobId);
  }
}

function renderResult(data) {
  const box = $("historyResult");
  const lines = data.results || [];
  if (!lines.length) {
    box.className = "result-view empty";
    box.textContent = "这条历史没有 perftest 结果输出。";
    return;
  }
  const { rows, events } = parseResultLines(lines);
  const bestAverage = rows.length ? Math.max(...rows.map((row) => row.average)) : 0;
  const avgBandwidth = rows.length ? rows.reduce((sum, row) => sum + row.average, 0) / rows.length : 0;
  const totalMsgRate = rows.reduce((sum, row) => sum + row.msgRate, 0);
  const statusClass = jobStatusClass(data.status, rows);

  box.className = "result-view";
  box.innerHTML = `
    <div class="result-summary">
      <div class="metric-card"><span>任务状态</span><strong class="status-pill ${statusClass}">${escapeHtml(jobStatusText(data.status, rows))}</strong></div>
      <div class="metric-card"><span>平均带宽</span><strong>${formatNumber(avgBandwidth)} Gb/s</strong></div>
      <div class="metric-card"><span>最佳带宽</span><strong>${formatNumber(bestAverage)} Gb/s</strong></div>
      <div class="metric-card"><span>消息速率</span><strong>${formatNumber(totalMsgRate, 3)} Mpps</strong></div>
    </div>
    ${resultGroupsHtml(data, rows, "没有解析到结果表。")}
    <details class="raw-results">
      <summary>原始输出</summary>
      <pre>${escapeHtml(lines.join("\n"))}</pre>
    </details>
    ${
      events.length
        ? `<div class="result-events">${events
            .slice(-6)
            .map((event) => `<div>${escapeHtml(event.replace(/^\[[^\]]+\]\s+/, ""))}</div>`)
            .join("")}</div>`
        : ""
    }`;
  bindResultGroupClicks();
}

async function loadHistory() {
  const data = await api("/api/jobs");
  const jobs = data.jobs || [];
  const signature = historyDataSignature(jobs);
  if (signature !== state.historySignature) {
    state.jobs = jobs;
    state.historySignature = signature;
    renderHistory();
  }
  if (state.initialJobId) {
    const jobId = state.initialJobId;
    state.initialJobId = "";
    if (state.jobs.some((job) => job.id === jobId)) {
      viewJob(jobId).catch((err) => showToast(`历史任务打开失败：${err.message}`, "bad"));
    } else {
      showToast(`未找到历史任务 ${jobId}`, "warn", 5200);
    }
  }
}

async function viewJob(jobId) {
  const data = await api(`/api/jobs/${jobId}`);
  renderJobDetail(data);
  openHistoryModal();
  showToast(`已加载历史任务 ${data.id}`, "ok");
}

function renderJobDetail(data) {
  const signature = jobDetailSignature(data);
  if (signature === state.detailSignature) return;
  state.detailSignature = signature;
  const rows = parseResultLines(data.results || []).rows;
  const logEl = $("historyLog");
  const shouldStickToBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  state.viewedJobId = data.id;
  $("historyModalTitle").textContent = `历史结果：${data.id}`;
  $("historyModalMeta").textContent = `${formatDateTime(data.createdAt)} · ${jobStatusText(data.status, rows)}`;
  logEl.textContent = [`任务 ${data.id} 状态：${jobStatusText(data.status, rows)}`, "", ...displayLogs(data, rows)].join("\n");
  if (shouldStickToBottom) logEl.scrollTop = logEl.scrollHeight;
  renderResult(data);
}

async function refreshViewedJob() {
  if (!state.viewedJobId || $("historyModal").hidden) return;
  const data = await api(`/api/jobs/${state.viewedJobId}`);
  renderJobDetail(data);
}

function openHistoryModal() {
  $("historyModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeHistoryModal() {
  $("historyModal").hidden = true;
  document.body.classList.remove("modal-open");
  state.viewedJobId = "";
  state.detailSignature = "";
}

async function deleteHistoryJobs(jobIds) {
  const ids = jobIds.filter(Boolean);
  if (!ids.length) return;
  const ok = window.confirm(`确认删除 ${ids.length} 条历史记录？删除后不可恢复。`);
  if (!ok) return;
  const data = await api("/api/jobs/delete", {
    method: "POST",
    body: JSON.stringify({ jobIds: ids }),
  });
  state.jobs = state.jobs.filter((job) => !ids.includes(job.id));
  state.historySignature = "";
  ids.forEach((id) => state.selectedIds.delete(id));
  renderHistory();
  $("historyResult").className = "result-view empty";
  $("historyResult").textContent = "选择一条历史记录查看结果。";
  $("historyLog").textContent = "暂无任务";
  closeHistoryModal();
  showToast(`已删除 ${data.deleted} 条历史记录`, "ok");
}

async function rerunHistoryJob(jobId) {
  if (!jobId) return;
  const data = await api(`/api/jobs/${jobId}/rerun`, { method: "POST", body: "{}" });
  localStorage.setItem("roceCurrentJob", data.id);
  showToast(`已重新发起任务：${data.id}`, "ok", 3200);
  window.location.href = "/";
}

$("historySearch").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderHistory();
});
$("historyStatus").addEventListener("change", (event) => {
  state.status = event.target.value;
  renderHistory();
});
$("refreshHistory").addEventListener("click", () => {
  loadHistory().catch((err) => showToast(`历史记录刷新失败：${err.message}`, "bad"));
});
$("deleteFilteredHistory").addEventListener("click", () => {
  const ids = [...state.selectedIds];
  deleteHistoryJobs(ids).catch((err) => showToast(`删除失败：${err.message}`, "bad"));
});
$("closeHistoryModal").addEventListener("click", closeHistoryModal);
document.querySelectorAll("[data-close-modal]").forEach((item) => item.addEventListener("click", closeHistoryModal));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("historyModal").hidden) closeHistoryModal();
});

loadHistory().catch((err) => {
  $("historyList").textContent = `历史记录加载失败：${err.message}`;
});

state.refreshTimer = setInterval(() => {
  loadHistory()
    .then(() => refreshViewedJob())
    .catch((err) => showToast(`历史记录刷新失败：${err.message}`, "bad"));
}, 2000);
