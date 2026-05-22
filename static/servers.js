const state = {
  hosts: [],
  selectedIds: new Set(),
  toastTimer: null,
  page: 1,
  pageSize: 25,
  search: "",
  saveTimer: null,
  dirty: false,
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
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

function normalizeHost(host, index) {
  if (!host.id) host.id = crypto.randomUUID();
  if (!host.address) host.address = "";
  if (!host.name) host.name = host.address || `server-${index + 1}`;
  if (!host.sshPort) host.sshPort = "22";
  if (!host.sshUser) host.sshUser = "root";
  if (host.enabled === undefined) host.enabled = true;
  if (!host.role) host.role = "client";
  if (!host.device) host.device = "mlx5_0";
  if (host.gidIndex === undefined || host.gidIndex === null) host.gidIndex = "";
  if (host.port === undefined || host.port === null) host.port = "";
  return host;
}

function serverRow(host) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input data-select type="checkbox" ${state.selectedIds.has(host.id) ? "checked" : ""}></td>
    <td><span class="enabled-indicator ${host.enabled !== false ? "on" : "off"}"><i></i>${host.enabled !== false ? "启用" : "停用"}</span></td>
    <td><input data-key="name" value="${escapeHtml(host.name || "")}" placeholder="例如 node-a"></td>
    <td><input data-key="address" value="${escapeHtml(host.address || "")}" placeholder="例如 28.197.226.5"></td>
    <td><input data-key="sshPort" value="${escapeHtml(host.sshPort || "22")}" placeholder="22"></td>
    <td><input data-key="sshUser" value="${escapeHtml(host.sshUser || "root")}" placeholder="root"></td>
    <td><input data-key="sshPassword" type="password" autocomplete="new-password" value="${escapeHtml(host.sshPassword || "")}" placeholder="密码"></td>
    <td><button class="row-delete" data-remove type="button">删除</button></td>
  `;
  tr.querySelectorAll("input").forEach((input) => {
    if (input.dataset.select !== undefined) return;
    input.addEventListener("input", () => {
      syncHost(host, tr);
      scheduleServerSave();
    });
    input.addEventListener("change", () => {
      syncHost(host, tr);
      scheduleServerSave();
    });
  });
  tr.querySelector("[data-select]").addEventListener("change", (event) => {
    if (event.target.checked) state.selectedIds.add(host.id);
    else state.selectedIds.delete(host.id);
    syncServerSelectionState();
  });
  tr.querySelector("[data-remove]").addEventListener("click", () => {
    state.hosts = state.hosts.filter((item) => item.id !== host.id);
    state.selectedIds.delete(host.id);
    renderServers();
    saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
  });
  return tr;
}

function syncHost(host, tr) {
  tr.querySelectorAll("[data-key]").forEach((input) => {
    const key = input.dataset.key;
    host[key] = input.type === "checkbox" ? input.checked : input.value;
  });
}

function renderServers() {
  const body = $("serversBody");
  state.hosts.forEach(normalizeHost);
  const filtered = filteredHosts();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);
  body.innerHTML = "";
  pageRows.forEach((host) => body.appendChild(serverRow(host)));
  $("pageInfo").textContent = filtered.length
    ? `${start + 1}-${start + pageRows.length} / ${filtered.length}`
    : "0-0 / 0";
  $("serverListCount").textContent = `共 ${state.hosts.length} 台，当前 ${filtered.length} 台`;
  $("prevPage").disabled = state.page <= 1;
  $("nextPage").disabled = state.page >= totalPages;
  syncServerSelectionState(pageRows);
}

function syncServerSelectionState(pageRows = null) {
  state.selectedIds.forEach((id) => {
    if (!state.hosts.some((host) => host.id === id)) state.selectedIds.delete(id);
  });
  const filtered = filteredHosts();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  const rows = pageRows || filtered.slice(start, start + state.pageSize);
  const selectedTargets = selectedOrFilteredHosts();
  $("enableFiltered").disabled = selectedTargets.length === 0;
  $("disableFiltered").disabled = selectedTargets.length === 0;
  $("scanSelected").disabled = selectedTargets.length === 0;
  $("deleteFiltered").disabled = selectedTargets.length === 0;
  const selectedOnPage = rows.filter((host) => state.selectedIds.has(host.id)).length;
  $("toggleFiltered").checked = rows.length > 0 && selectedOnPage === rows.length;
  $("toggleFiltered").indeterminate = selectedOnPage > 0 && selectedOnPage < rows.length;
  $("toggleFiltered").disabled = rows.length === 0;
}

function filteredHosts() {
  const keyword = state.search.trim().toLowerCase();
  if (!keyword) return state.hosts;
  return state.hosts.filter((host) => {
    return [host.name, host.address, host.sshUser, host.sshPort]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
}

function selectedHosts() {
  return state.hosts.filter((host) => state.selectedIds.has(host.id));
}

function selectedOrFilteredHosts() {
  const selected = selectedHosts();
  return selected.length ? selected : filteredHosts();
}

async function loadServers() {
  const data = await api("/api/hosts");
  state.hosts = data.hosts.map(normalizeHost);
  renderServers();
}

async function saveServers({ silent = false } = {}) {
  state.hosts.forEach(normalizeHost);
  await api("/api/hosts", {
    method: "POST",
    body: JSON.stringify({ hosts: state.hosts }),
  });
  state.dirty = false;
  if (!silent) showToast("服务器已自动保存。", "ok");
}

function scheduleServerSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
  }, 450);
}

function flushServerSave() {
  if (!state.dirty || !state.hosts.length) return;
  clearTimeout(state.saveTimer);
  state.hosts.forEach(normalizeHost);
  const payload = JSON.stringify({ hosts: state.hosts });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/hosts", payload);
  }
  state.dirty = false;
}

function addServer() {
  state.hosts.push(
    normalizeHost({
      id: crypto.randomUUID(),
      name: "",
      address: "",
      sshPort: "22",
      sshUser: "root",
      sshPassword: "",
      enabled: true,
      role: "client",
      device: "mlx5_0",
      gidIndex: "",
      port: "",
    }, state.hosts.length)
  );
  state.page = Math.max(1, Math.ceil(state.hosts.length / state.pageSize));
  renderServers();
  saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
}

function bulkAddServers() {
  const rows = $("bulkServers").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  rows.forEach((line, index) => {
    const [name, address, sshPort, sshUser, sshPassword] = line.split(",").map((part) => part.trim());
    if (!address) throw new Error(`第 ${index + 1} 行缺少地址`);
    state.hosts.push(
      normalizeHost({
        id: crypto.randomUUID(),
        name: name || address,
        address,
        sshPort: sshPort || "22",
        sshUser: sshUser || "root",
        sshPassword: sshPassword || "",
        enabled: true,
        role: "client",
        device: "mlx5_0",
        gidIndex: "",
        port: "",
      }, state.hosts.length)
    );
  });
  $("bulkServers").value = "";
  state.page = Math.max(1, Math.ceil(filteredHosts().length / state.pageSize));
  renderServers();
  saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
}

function setFilteredEnabled(enabled) {
  const targets = selectedOrFilteredHosts();
  targets.forEach((host) => {
    host.enabled = enabled;
  });
  renderServers();
  saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
  $("excelImportStatus").textContent = `${enabled ? "已启用" : "已禁用"} ${targets.length} 台服务器，已自动保存`;
}

function deleteFilteredHosts() {
  const targets = selectedOrFilteredHosts();
  if (!targets.length) return;
  const scope = selectedHosts().length ? "选中" : state.search.trim() ? "当前搜索结果" : "全部服务器";
  const ok = window.confirm(`确认删除${scope}中的 ${targets.length} 台服务器？删除后会自动保存。`);
  if (!ok) return;
  const deletingIds = new Set(targets.map((host) => host.id));
  state.hosts = state.hosts.filter((host) => !deletingIds.has(host.id));
  deletingIds.forEach((id) => state.selectedIds.delete(id));
  state.page = 1;
  renderServers();
  saveServers({ silent: true }).catch((err) => showToast(`自动保存失败：${err.message}`, "bad", 7000));
  $("excelImportStatus").textContent = `已删除 ${targets.length} 台服务器，已自动保存`;
}

async function scanSelectedHosts() {
  const targets = selectedOrFilteredHosts();
  if (!targets.length) {
    $("excelImportStatus").textContent = "没有可扫描的服务器。";
    showToast("没有可扫描的服务器。", "warn");
    return;
  }
  $("scanSelected").disabled = true;
  let ok = 0;
  let failed = 0;
  showToast(`开始批量扫描 ${targets.length} 台服务器...`, "info", 0);
  for (const host of targets) {
    const name = host.name || host.address || "服务器";
    $("excelImportStatus").textContent = `正在扫描 ${name}（${ok + failed + 1}/${targets.length}）...`;
    showToast(`正在扫描 ${name}（${ok + failed + 1}/${targets.length}）...`, "info", 0);
    try {
      const data = await api("/api/hosts/scan", {
        method: "POST",
        body: JSON.stringify({ hostId: host.id, host }),
      });
      host.scanDevices = data.devices || [];
      host.scanAddresses = data.addresses || [];
      const firstDevice = host.scanDevices.find((item) => item.addresses && item.addresses.length);
      if (firstDevice && firstDevice.device) host.device = firstDevice.device;
      if (firstDevice && firstDevice.addresses && firstDevice.addresses[0]) {
        host.roceIp = firstDevice.addresses[0];
      } else if (host.scanAddresses[0]) {
        host.roceIp = host.scanAddresses[0];
      }
      await api("/api/hosts/scan-cache", {
        method: "POST",
        body: JSON.stringify({
          hostId: host.id,
          scanDevices: host.scanDevices,
          scanAddresses: host.scanAddresses,
          device: host.device || "",
          roceIp: host.roceIp || "",
        }),
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      $("excelImportStatus").textContent = `${name} 扫描失败：${err.message}`;
    }
  }
  renderServers();
  const message = `批量扫描完成：成功 ${ok} 台，失败 ${failed} 台。扫描结果已保存。`;
  $("excelImportStatus").textContent = message;
  showToast(message, failed ? "warn" : "ok", 5200);
}

async function importExcel(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new Error("请导入 .xlsx 格式的 Excel 文件");
  }
  $("excelImportStatus").textContent = `正在读取 ${file.name}...`;
  const contentBase64 = await readFileAsDataUrl(file);
  const data = await api("/api/hosts/import-xlsx", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, contentBase64 }),
  });
  const imported = data.hosts.map(normalizeHost);
  state.hosts.push(...imported);
  state.page = Math.max(1, Math.ceil(filteredHosts().length / state.pageSize));
  renderServers();
  await saveServers({ silent: true });
  $("excelImportStatus").textContent = `已导入 ${imported.length} 台服务器，已自动保存`;
}

$("addServer").addEventListener("click", addServer);
$("serverSearch").addEventListener("input", (event) => {
  state.search = event.target.value;
  state.page = 1;
  renderServers();
});
$("pageSize").addEventListener("change", (event) => {
  state.pageSize = Number(event.target.value);
  state.page = 1;
  renderServers();
});
$("prevPage").addEventListener("click", () => {
  state.page -= 1;
  renderServers();
});
$("nextPage").addEventListener("click", () => {
  state.page += 1;
  renderServers();
});
$("enableFiltered").addEventListener("click", () => setFilteredEnabled(true));
$("disableFiltered").addEventListener("click", () => setFilteredEnabled(false));
$("scanSelected").addEventListener("click", () => scanSelectedHosts().catch((err) => {
  $("excelImportStatus").textContent = `扫描失败：${err.message}`;
}));
$("deleteFiltered").addEventListener("click", deleteFilteredHosts);
$("toggleFiltered").addEventListener("change", (event) => {
  const filtered = filteredHosts();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);
  pageRows.forEach((host) => {
    if (event.target.checked) state.selectedIds.add(host.id);
    else state.selectedIds.delete(host.id);
  });
  document.querySelectorAll("#serversBody [data-select]").forEach((checkbox) => {
    checkbox.checked = event.target.checked;
  });
  syncServerSelectionState(pageRows);
});
$("bulkAddServers").addEventListener("click", () => {
  try {
    bulkAddServers();
  } catch (err) {
    window.alert(err.message);
  }
});
$("chooseExcel").addEventListener("click", () => $("excelFile").click());
$("excelFile").addEventListener("change", (event) => {
  importExcel(event.target.files[0])
    .catch((err) => {
      $("excelImportStatus").textContent = "导入失败";
      window.alert(err.message);
    })
    .finally(() => {
      event.target.value = "";
    });
});
window.addEventListener("beforeunload", flushServerSave);

loadServers();
