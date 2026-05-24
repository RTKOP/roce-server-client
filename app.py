#!/usr/bin/env python3
import json
import base64
import io
import os
import re
import select
import shlex
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

if os.name != "nt":
    import fcntl
    import pty
    import termios
else:
    fcntl = None
    pty = None
    termios = None

APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
ASSET_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
ROOT = APP_DIR
STATIC_DIR = ASSET_DIR / "static"
DATA_DIR = APP_DIR / "data"
HOSTS_FILE = DATA_DIR / "hosts.json"
JOBS_FILE = DATA_DIR / "jobs.json"
JOBS_DIR = DATA_DIR / "jobs"
JOBS_INDEX_FILE = JOBS_DIR / "index.json"
DB_FILE = DATA_DIR / "roce_console.db"

DEFAULT_HOSTS = [
    {
        "id": "host-a",
        "name": "server-a",
        "address": "192.168.1.10",
        "sshUser": "root",
        "sshPort": "22",
        "sshKey": "",
        "role": "server",
        "device": "mlx5_0",
        "gidIndex": "3",
        "port": "1",
        "enabled": True,
    },
    {
        "id": "host-b",
        "name": "server-b",
        "address": "192.168.1.11",
        "sshUser": "root",
        "sshPort": "22",
        "sshKey": "",
        "role": "client",
        "targetServerId": "host-a",
        "device": "mlx5_0",
        "gidIndex": "3",
        "port": "1",
        "enabled": True,
    },
]

TEST_TO_BINARY = {
    "write_bw": "ib_write_bw",
    "read_bw": "ib_read_bw",
    "send_bw": "ib_send_bw",
    "write_lat": "ib_write_lat",
    "read_lat": "ib_read_lat",
    "send_lat": "ib_send_lat",
}

EXCEL_HEADERS = ["名称", "地址", "SSH端口", "用户", "密码", "启用", "角色", "网卡", "RoCE IP", "目标Server名称", "GID", "IB端口"]
HEADER_ALIASES = {
    "名称": "name",
    "name": "name",
    "服务器名称": "name",
    "地址": "address",
    "ip": "address",
    "ssh地址": "address",
    "ssh地址/ip": "address",
    "sshport": "sshPort",
    "ssh端口": "sshPort",
    "端口": "sshPort",
    "用户": "sshUser",
    "用户名": "sshUser",
    "user": "sshUser",
    "密码": "sshPassword",
    "password": "sshPassword",
    "启用": "enabled",
    "enabled": "enabled",
    "角色": "role",
    "role": "role",
    "网卡": "device",
    "device": "device",
    "roceip": "roceIp",
    "roce ip": "roceIp",
    "目标server名称": "targetServerName",
    "目标server": "targetServerName",
    "targetserver": "targetServerName",
    "gid": "gidIndex",
    "gidindex": "gidIndex",
    "ib端口": "port",
    "ibport": "port",
}


@dataclass
class ProcessRef:
    host: str
    command: str
    process: Optional[subprocess.Popen] = None


@dataclass
class Job:
    id: str
    created_at: float
    config: dict[str, Any]
    dry_run: bool
    status: str = "queued"
    logs: list[str] = field(default_factory=list)
    results: list[str] = field(default_factory=list)
    processes: list[ProcessRef] = field(default_factory=list)
    stop_requested: bool = False
    dirty: bool = True

    def log(self, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.logs.append(f"[{timestamp}] {message}")
        self.logs = self.logs[-600:]
        self.dirty = True
        persist_jobs_throttled()

    def result(self, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.results.append(f"[{timestamp}] {message}")
        self.results = self.results[-1000:]
        self.dirty = True
        persist_jobs_throttled()

    def has_perftest_measurement(self) -> bool:
        pattern = re.compile(r"\]\s+(?:SERVER|CLIENT)\s+[^:]+:\s+\d+\s+\d+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s*$")
        return any(pattern.search(line) for line in self.results)


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
PERSIST_LOCK = threading.Lock()
DB_LOCK = threading.Lock()
LAST_PERSIST_AT = 0.0
RUNNING_PERSIST_INTERVAL = 10.0


def ensure_data() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    JOBS_DIR.mkdir(exist_ok=True)
    init_db()
    ensure_hosts_seeded()


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db() -> None:
    with DB_LOCK:
        with db_connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_kv (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    status TEXT NOT NULL,
                    dry_run INTEGER NOT NULL,
                    config_json TEXT NOT NULL,
                    summary_config_json TEXT NOT NULL,
                    logs_json TEXT NOT NULL,
                    results_json TEXT NOT NULL,
                    logs_count INTEGER NOT NULL,
                    results_count INTEGER NOT NULL,
                    last_log TEXT NOT NULL,
                    last_result TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)")
            conn.commit()


def kv_get(key: str, default: Any) -> Any:
    with DB_LOCK:
        with db_connect() as conn:
            row = conn.execute("SELECT value FROM app_kv WHERE key = ?", (key,)).fetchone()
    return json_loads(row["value"], default) if row else default


def kv_set(key: str, value: Any) -> None:
    with DB_LOCK:
        with db_connect() as conn:
            conn.execute(
                """
                INSERT INTO app_kv(key, value, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (key, json_dumps(value), time.time()),
            )
            conn.commit()


def ensure_hosts_seeded() -> None:
    if kv_get("hosts", None) is not None:
        return
    hosts = DEFAULT_HOSTS
    if HOSTS_FILE.exists():
        try:
            legacy_hosts = json.loads(HOSTS_FILE.read_text(encoding="utf-8"))
            if isinstance(legacy_hosts, list):
                hosts = legacy_hosts
        except (OSError, json.JSONDecodeError):
            hosts = DEFAULT_HOSTS
    kv_set("hosts", hosts)


def sanitize_config(config: dict[str, Any], keep_password: bool = False) -> dict[str, Any]:
    clean_config = dict(config)
    clean_hosts = []
    for host in clean_config.get("hosts", []):
        clean_host = dict(host)
        if not keep_password:
            clean_host.pop("sshPassword", None)
        clean_hosts.append(clean_host)
    clean_config["hosts"] = clean_hosts
    return clean_config


def summarize_config(config: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "testType": config.get("testType"),
        "allSizes": config.get("allSizes"),
        "runInfinitely": config.get("runInfinitely"),
        "hosts": [],
    }
    hosts = []
    for host in config.get("hosts", []):
        if host.get("enabled") is False:
            continue
        hosts.append(
            {
                "name": host.get("name"),
                "address": host.get("address"),
                "role": host.get("role"),
                "device": host.get("device"),
                "roceIp": host.get("roceIp"),
                "enabled": host.get("enabled", True),
            }
        )
    summary["hosts"] = hosts
    return summary


def job_to_record(job: Job) -> dict[str, Any]:
    status = "stopped" if job.status in {"queued", "running"} else job.status
    return {
        "id": job.id,
        "createdAt": job.created_at,
        "config": sanitize_config(job.config),
        "dryRun": job.dry_run,
        "status": status,
        "logs": job.logs,
        "results": job.results,
    }


def job_to_index_record(job: Job) -> dict[str, Any]:
    status = "stopped" if job.status in {"queued", "running"} else job.status
    return {
        "id": job.id,
        "createdAt": job.created_at,
        "config": summarize_config(job.config),
        "dryRun": job.dry_run,
        "status": status,
        "logsCount": len(job.logs),
        "resultsCount": len(job.results),
        "lastLog": job.logs[-1] if job.logs else "",
        "lastResult": job.results[-1] if job.results else "",
    }


def job_detail_path(job_id: str) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(job_id))
    return JOBS_DIR / f"{safe_id}.json"


def write_json_file(path: Path, data: Any) -> None:
    path.parent.mkdir(exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    temp_path.replace(path)


def job_to_db_record(job: Job) -> tuple[Any, ...]:
    status = "stopped" if job.status in {"queued", "running"} else job.status
    return (
        job.id,
        job.created_at,
        status,
        1 if job.dry_run else 0,
        json_dumps(sanitize_config(job.config)),
        json_dumps(summarize_config(job.config)),
        json_dumps(job.logs),
        json_dumps(job.results),
        len(job.logs),
        len(job.results),
        job.logs[-1] if job.logs else "",
        job.results[-1] if job.results else "",
        time.time(),
    )


def upsert_job_records(jobs: list[Job]) -> None:
    if not jobs:
        return
    rows = [job_to_db_record(job) for job in jobs]
    with DB_LOCK:
        with db_connect() as conn:
            conn.executemany(
                """
                INSERT INTO jobs(
                    id, created_at, status, dry_run, config_json, summary_config_json,
                    logs_json, results_json, logs_count, results_count, last_log, last_result, updated_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    created_at = excluded.created_at,
                    status = excluded.status,
                    dry_run = excluded.dry_run,
                    config_json = excluded.config_json,
                    summary_config_json = excluded.summary_config_json,
                    logs_json = excluded.logs_json,
                    results_json = excluded.results_json,
                    logs_count = excluded.logs_count,
                    results_count = excluded.results_count,
                    last_log = excluded.last_log,
                    last_result = excluded.last_result,
                    updated_at = excluded.updated_at
                """,
                rows,
            )
            conn.commit()


def db_job_records(limit: int = 100) -> list[dict[str, Any]]:
    with DB_LOCK:
        with db_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, created_at, status, dry_run, config_json, logs_json, results_json
                FROM jobs
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
    records = []
    for row in reversed(rows):
        records.append(
            {
                "id": row["id"],
                "createdAt": row["created_at"],
                "status": row["status"],
                "dryRun": bool(row["dry_run"]),
                "config": json_loads(row["config_json"], {}),
                "logs": json_loads(row["logs_json"], []),
                "results": json_loads(row["results_json"], []),
            }
        )
    return records


def db_has_jobs() -> bool:
    with DB_LOCK:
        with db_connect() as conn:
            row = conn.execute("SELECT 1 FROM jobs LIMIT 1").fetchone()
    return row is not None


def db_delete_jobs(job_ids: set[str]) -> int:
    if not job_ids:
        return 0
    with DB_LOCK:
        with db_connect() as conn:
            before = conn.total_changes
            conn.executemany("DELETE FROM jobs WHERE id = ?", [(job_id,) for job_id in job_ids])
            conn.commit()
            return conn.total_changes - before


def persist_jobs() -> None:
    ensure_data()
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda item: item.created_at)[-100:]
        dirty_jobs = [job for job in jobs if job.dirty]
    upsert_job_records(dirty_jobs)
    for job in dirty_jobs:
        job.dirty = False


def persist_jobs_throttled(interval: float = RUNNING_PERSIST_INTERVAL) -> None:
    global LAST_PERSIST_AT
    now = time.time()
    if now - LAST_PERSIST_AT < interval:
        return
    with PERSIST_LOCK:
        now = time.time()
        if now - LAST_PERSIST_AT < interval:
            return
        persist_jobs()
        LAST_PERSIST_AT = now


def persist_jobs_force() -> None:
    global LAST_PERSIST_AT
    with PERSIST_LOCK:
        persist_jobs()
        LAST_PERSIST_AT = time.time()


def load_jobs() -> None:
    ensure_data()
    needs_migration = False
    if db_has_jobs():
        records = db_job_records(100)
    else:
        needs_migration = True
        records = []
        try:
            index_records = json.loads(JOBS_INDEX_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            index_records = []
        if index_records:
            for item in index_records[-100:]:
                job_id = item.get("id")
                if not job_id:
                    continue
                try:
                    records.append(json.loads(job_detail_path(str(job_id)).read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    records.append(item)
        else:
            try:
                records = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                records = []
    with JOBS_LOCK:
        JOBS.clear()
        for record in records[-100:]:
            status = record.get("status", "finished")
            if status in {"queued", "running"}:
                status = "stopped"
            job = Job(
                id=record.get("id") or uuid.uuid4().hex[:12],
                created_at=float(record.get("createdAt") or time.time()),
                config=record.get("config") or {},
                dry_run=bool(record.get("dryRun", False)),
                status=status,
                logs=record.get("logs") or [],
                results=record.get("results") or [],
                dirty=False,
            )
            JOBS[job.id] = job
    if needs_migration:
        with JOBS_LOCK:
            for job in JOBS.values():
                job.dirty = True
        persist_jobs()


def delete_jobs(job_ids: list[str]) -> int:
    deleting = {str(job_id) for job_id in job_ids if str(job_id)}
    if not deleting:
        return 0
    with JOBS_LOCK:
        deleted = 0
        for job_id in list(JOBS.keys()):
            if job_id in deleting:
                JOBS.pop(job_id, None)
                try:
                    job_detail_path(job_id).unlink()
                except OSError:
                    pass
                deleted += 1
    deleted += db_delete_jobs(deleting)
    persist_jobs()
    return min(deleted, len(deleting))


def active_job() -> Optional[Job]:
    active = [job for job in JOBS.values() if job.status in {"queued", "running"}]
    if not active:
        return None
    return max(active, key=lambda item: item.created_at)


def rehydrate_job_config(config: dict[str, Any]) -> dict[str, Any]:
    current_hosts = load_hosts()
    by_id = {str(host.get("id")): host for host in current_hosts if host.get("id")}
    by_address = {str(host.get("address")): host for host in current_hosts if host.get("address")}
    restored = dict(config)
    hosts = []
    for host in config.get("hosts", []):
        current = by_id.get(str(host.get("id"))) or by_address.get(str(host.get("address")))
        merged = dict(current or {})
        merged.update(host)
        if current and not merged.get("sshPassword"):
            merged["sshPassword"] = current.get("sshPassword", "")
        hosts.append(merged)
    restored["hosts"] = hosts
    restored["dryRun"] = False
    return restored


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8") if length else "{}"
    return json.loads(raw or "{}")


def send_json(handler: SimpleHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def load_hosts() -> list[dict[str, Any]]:
    ensure_data()
    hosts = kv_get("hosts", DEFAULT_HOSTS)
    return hosts if isinstance(hosts, list) else DEFAULT_HOSTS


def save_hosts(hosts: list[dict[str, Any]]) -> None:
    ensure_data()
    kv_set("hosts", hosts)
    # Keep a human-readable local backup for existing users, but SQLite is authoritative.
    write_json_file(HOSTS_FILE, hosts)


def save_topology(hosts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    existing_by_id = {str(host.get("id")): host for host in load_hosts()}
    merged = []
    for host in hosts:
        current = dict(existing_by_id.get(str(host.get("id")), {}))
        current.update(host)
        merged.append(current)
    save_hosts(merged)
    return merged


def save_host_scan_cache(host_id: str, scan_devices: list[dict[str, Any]], scan_addresses: list[str], device: str = "", roce_ip: str = "") -> dict[str, Any]:
    hosts = load_hosts()
    for host in hosts:
        if str(host.get("id")) == str(host_id):
            host["scanDevices"] = scan_devices
            host["scanAddresses"] = scan_addresses
            if device:
                host["device"] = device
            if roce_ip:
                host["roceIp"] = roce_ip
            save_hosts(hosts)
            return host
    raise ValueError("未找到要保存扫描结果的服务器")


def parse_bool_cell(value: Any, default: bool = True) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return default
    return text not in {"0", "false", "no", "n", "否", "禁用", "不启用", "disabled"}


def normalize_header(value: Any) -> str:
    return "".join(str(value or "").strip().lower().split())


def column_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    index = 0
    for ch in letters:
        index = index * 26 + ord(ch) - ord("A") + 1
    return max(0, index - 1)


def xlsx_cell_text(cell: ET.Element, shared_strings: list[str], namespaces: dict[str, str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "s":
        raw = cell.findtext("main:v", default="", namespaces=namespaces)
        try:
            return shared_strings[int(raw)]
        except (ValueError, IndexError):
            return raw
    if cell_type == "inlineStr":
        return "".join(text.text or "" for text in cell.findall(".//main:t", namespaces))
    return cell.findtext("main:v", default="", namespaces=namespaces)


def parse_xlsx_hosts(content: bytes) -> list[dict[str, Any]]:
    namespaces = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("main:si", namespaces):
                shared_strings.append("".join(text.text or "" for text in item.findall(".//main:t", namespaces)))

        sheet_name = "xl/worksheets/sheet1.xml"
        if sheet_name not in archive.namelist():
            worksheet_names = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet")]
            if not worksheet_names:
                raise ValueError("Excel 文件中没有可读取的工作表")
            sheet_name = sorted(worksheet_names)[0]

        root = ET.fromstring(archive.read(sheet_name))
        rows = []
        for row in root.findall(".//main:sheetData/main:row", namespaces):
            values: list[str] = []
            for cell in row.findall("main:c", namespaces):
                idx = column_index(cell.attrib.get("r", "A1"))
                while len(values) <= idx:
                    values.append("")
                values[idx] = xlsx_cell_text(cell, shared_strings, namespaces).strip()
            if any(values):
                rows.append(values)

    if len(rows) < 2:
        return []

    header_keys = [HEADER_ALIASES.get(normalize_header(value), "") for value in rows[0]]
    hosts = []
    for row_number, row in enumerate(rows[1:], start=2):
        mapped = {key: row[index].strip() for index, key in enumerate(header_keys) if key and index < len(row)}
        if not mapped.get("address"):
            if any(row):
                raise ValueError(f"第 {row_number} 行缺少地址")
            continue
        host = {
            "id": uuid.uuid4().hex,
            "name": mapped.get("name") or mapped["address"],
            "address": mapped["address"],
            "sshPort": mapped.get("sshPort") or "22",
            "sshUser": mapped.get("sshUser") or "root",
            "sshPassword": mapped.get("sshPassword") or "",
            "enabled": parse_bool_cell(mapped.get("enabled"), True),
            "role": mapped.get("role") or "client",
            "device": mapped.get("device") or "mlx5_0",
            "roceIp": mapped.get("roceIp") or "",
            "targetServerName": mapped.get("targetServerName") or "",
            "gidIndex": mapped.get("gidIndex") or "",
            "port": mapped.get("port") or "",
        }
        hosts.append(host)
    return hosts


def xlsx_col_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def inline_string_cell(ref: str, value: Any) -> str:
    text = xml_escape(str(value))
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'


def build_hosts_template_xlsx() -> bytes:
    rows = [
        EXCEL_HEADERS,
        ["GPU001", "28.197.226.5", "56000", "root", "password", "是", "server", "mlx5_0", "", "", "", ""],
        ["GPU002", "28.197.226.6", "56000", "root", "password", "是", "client", "mlx5_0", "", "GPU001", "", ""],
    ]
    row_xml = []
    for row_index, row in enumerate(rows, start=1):
        cells = [inline_string_cell(f"{xlsx_col_name(col_index)}{row_index}", value) for col_index, value in enumerate(row, start=1)]
        row_xml.append(f'<row r="{row_index}">{"".join(cells)}</row>')

    sheet_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>
    <col min="1" max="1" width="18" customWidth="1"/>
    <col min="2" max="2" width="18" customWidth="1"/>
    <col min="3" max="3" width="12" customWidth="1"/>
    <col min="4" max="4" width="12" customWidth="1"/>
    <col min="5" max="5" width="18" customWidth="1"/>
    <col min="6" max="12" width="16" customWidth="1"/>
  </cols>
  <sheetData>{"".join(row_xml)}</sheetData>
</worksheet>'''
    files = {
        "[Content_Types].xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>''',
        "_rels/.rels": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
        "xl/workbook.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="服务器导入模板" sheetId="1" r:id="rId1"/></sheets>
</workbook>''',
        "xl/_rels/workbook.xml.rels": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''',
        "xl/styles.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>''',
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return output.getvalue()


def ssh_target(host: dict[str, Any]) -> str:
    user = host.get("sshUser", "").strip()
    address = host.get("address", "").strip()
    return f"{user}@{address}" if user else address


def shell_join(args: list[str]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in args if str(arg) != "")


def build_perftest_args(host: dict[str, Any], config: dict[str, Any], server_ip: Optional[str], port: Optional[int]) -> list[str]:
    binary = TEST_TO_BINARY.get(config.get("testType"), "ib_write_bw")
    args = [binary]
    if server_ip:
        args.append(server_ip)
    device = str(host.get("device") or config.get("device") or "").strip()
    gid_index = str(host.get("gidIndex") or config.get("gidIndex") or "").strip()
    ib_port = str(host.get("port") or config.get("port") or "").strip()
    duration = str(config.get("duration") or "").strip()
    size = str(config.get("size", ""))
    mtu = str(config.get("mtu", ""))
    qp = str(config.get("qp") or "").strip()
    tx_depth = str(config.get("txDepth") or "").strip()

    if config.get("allSizes"):
        args.append("-a")
    if device:
        args.extend(["-d", str(device)])
    if ib_port:
        args.extend(["-i", str(ib_port)])
    if gid_index:
        args.extend(["-x", str(gid_index)])
    args.extend(["-F", "--report_gbits"])
    if config.get("runInfinitely"):
        args.append("--run_infinitely")
    elif duration:
        args.extend(["-D", duration])
    if qp:
        args.extend(["-q", qp])
    if tx_depth:
        args.extend(["-t", tx_depth])
    if port is not None:
        args.extend(["-p", str(port)])
    if size:
        args.extend(["-s", size])
    if mtu:
        args.extend(["-m", mtu])
    return args


def build_plan(config: dict[str, Any]) -> dict[str, Any]:
    hosts = [h for h in config.get("hosts", []) if h.get("enabled", True)]
    servers = [h for h in hosts if h.get("role") == "server"]
    clients = [h for h in hosts if h.get("role") == "client"]
    if not servers:
        raise ValueError("至少需要一台 server")
    if not clients:
        raise ValueError("至少需要一台 client")

    base_port_raw = str(config.get("basePort") or "").strip()
    base_port = int(base_port_raw) if base_port_raw else (18515 if len(clients) > 1 else None)
    servers_by_id = {str(h.get("id")): h for h in servers}
    pairs = []
    port = base_port

    def endpoint_key(host: dict[str, Any]) -> str:
        address = str(host.get("address") or "")
        device = str(host.get("device") or "")
        if device:
            return f"{address}|{device}"
        return "|".join(
            [
                address,
                str(host.get("roceIp") or ""),
            ]
        )

    used_server_endpoints: set[str] = set()
    used_client_endpoints: set[str] = set()

    def available_server_for(client: dict[str, Any]) -> dict[str, Any]:
        target_server_id = str(client.get("targetServerId") or "")
        if target_server_id:
            server = servers_by_id.get(target_server_id)
            if not server:
                raise ValueError(f"{client.get('name') or client.get('address')} 指定的目标 server 不存在")
            key = endpoint_key(server)
            if key in used_server_endpoints:
                raise ValueError(
                    f"{client.get('name') or client.get('address')} 指定的目标 server 网卡已被占用："
                    f"{server.get('name') or server.get('address')} {server.get('device') or ''}"
                )
            return server
        for server in servers:
            key = endpoint_key(server)
            if key not in used_server_endpoints:
                return server
        raise ValueError("可用 server 网卡数量不足：每个 server 网卡只能被一个 client 使用")

    for client_index, client in enumerate(clients):
        client_key = endpoint_key(client)
        if client_key in used_client_endpoints:
            raise ValueError(
                f"client 网卡重复使用：{client.get('name') or client.get('address')} {client.get('device') or ''}"
            )
        server = available_server_for(client)
        used_client_endpoints.add(client_key)
        used_server_endpoints.add(endpoint_key(server))
        server_ip = server.get("roceIp") or server.get("address")
        server_args = build_perftest_args(server, config, None, port)
        client_args = build_perftest_args(client, config, server_ip, port)
        server_cmd = shell_join(server_args)
        client_cmd = shell_join(client_args)
        pairs.append(
            {
                "server": server,
                "client": client,
                "serverCommand": server_cmd,
                "clientCommand": client_cmd,
                "port": port,
                "flow": 1,
            }
        )
        if port is not None:
            port += 1
    return {"pairs": pairs, "servers": servers, "clients": clients}


def ssh_command(host: dict[str, Any], remote_command: str) -> list[str]:
    ssh_port = str(host.get("sshPort") or "22").strip()
    ssh_password = str(host.get("sshPassword") or "")
    command = [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-p",
        ssh_port,
    ]
    if ssh_password:
        command.extend(["-o", "PreferredAuthentications=password,keyboard-interactive"])
    else:
        command.extend(["-o", "BatchMode=yes"])
    ssh_key = str(host.get("sshKey") or "").strip()
    if ssh_key:
        command.extend(["-i", ssh_key])
    command.extend([ssh_target(host), remote_command])
    return command


def run_ssh_capture(host: dict[str, Any], remote_command: str, timeout: int = 15) -> tuple[int, str]:
    cmd = ssh_command(host, remote_command)
    ssh_password = str(host.get("sshPassword") or "")
    if os.name == "nt" and ssh_password:
        return run_paramiko_capture(host, remote_command, timeout)
    if not ssh_password:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")

    master_fd, slave_fd = pty.openpty()

    def set_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        text=False,
        close_fds=True,
        preexec_fn=set_controlling_tty,
    )
    os.close(slave_fd)
    output = ""
    pending = ""
    password_sent = False
    started_at = time.time()
    try:
        while True:
            if time.time() - started_at > timeout:
                proc.terminate()
                raise TimeoutError(f"扫描超时：{host.get('name') or host.get('address')}")
            ready, _, _ = select.select([master_fd], [], [], 0.2)
            if ready:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b""
                if data:
                    text = data.decode("utf-8", errors="replace")
                    pending += text
                    if not password_sent and password_prompt_seen(pending):
                        os.write(master_fd, (ssh_password + "\n").encode("utf-8"))
                        password_sent = True
                        pending = ""
                    else:
                        output += text
                elif proc.poll() is not None:
                    break
            if proc.poll() is not None:
                break
    finally:
        os.close(master_fd)
    return proc.wait(), output


def import_paramiko():
    try:
        import paramiko  # type: ignore

        return paramiko
    except ImportError as exc:
        raise RuntimeError("Windows 密码登录需要 paramiko，请使用 Windows 打包脚本生成包含 paramiko 的 exe") from exc


def paramiko_client(host: dict[str, Any]):
    paramiko = import_paramiko()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=str(host.get("address") or ""),
        port=int(str(host.get("sshPort") or "22")),
        username=str(host.get("sshUser") or "root"),
        password=str(host.get("sshPassword") or ""),
        timeout=8,
        banner_timeout=8,
        auth_timeout=8,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def run_paramiko_capture(host: dict[str, Any], remote_command: str, timeout: int = 15) -> tuple[int, str]:
    client = paramiko_client(host)
    try:
        stdin, stdout, stderr = client.exec_command(remote_command, timeout=timeout)
        output = (stdout.read() or b"").decode("utf-8", errors="replace")
        output += (stderr.read() or b"").decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return code, output
    finally:
        client.close()


def pop_stream_messages(buffer: str) -> tuple[list[str], str]:
    last_separator = max(buffer.rfind("\n"), buffer.rfind("\r"))
    if last_separator < 0:
        return [], buffer
    complete = buffer[: last_separator + 1]
    rest = buffer[last_separator + 1 :]
    messages = [item for item in re.split(r"[\r\n]+", complete) if item]
    return messages, rest


def run_paramiko_stream(job: Job, host: dict[str, Any], remote_command: str, result_prefix: str = "") -> int:
    host_name = host.get("name") or host.get("address")
    job.log(f"{host_name}: paramiko {ssh_target(host)} {remote_command}")
    client = paramiko_client(host)
    try:
        channel = client.get_transport().open_session()
        job.processes.append(ProcessRef(host=host.get("address", ""), command=remote_command, process=None))
        channel.exec_command(remote_command)
        pending = ""
        while True:
            if channel.recv_ready():
                text = channel.recv(4096).decode("utf-8", errors="replace")
                pending += text
                messages, pending = pop_stream_messages(pending)
                for message in messages:
                    job.log(f"{host_name}: {message}")
                    if result_prefix:
                        job.result(f"{result_prefix} {host_name}: {message}")
            if channel.recv_stderr_ready():
                text = channel.recv_stderr(4096).decode("utf-8", errors="replace")
                pending += text
                messages, pending = pop_stream_messages(pending)
                for message in messages:
                    job.log(f"{host_name}: {message}")
                    if result_prefix:
                        job.result(f"{result_prefix} {host_name}: {message}")
            if channel.exit_status_ready():
                break
            if job.stop_requested:
                channel.close()
                break
            time.sleep(0.2)
        if pending.strip():
            message = pending.strip()
            job.log(f"{host_name}: {message}")
            if result_prefix:
                job.result(f"{result_prefix} {host_name}: {message}")
        code = channel.recv_exit_status() if not channel.closed else -15
        job.log(f"{host_name}: exit {code}")
        return code
    finally:
        client.close()


def password_prompt_seen(buffer: str) -> bool:
    lowered = buffer.lower()
    return "password:" in lowered or "passphrase" in lowered


def run_with_password(job: Job, host: dict[str, Any], cmd: list[str], password: str, result_prefix: str = "") -> int:
    if os.name == "nt":
        return run_paramiko_stream(job, host, cmd[-1], result_prefix)
    master_fd, slave_fd = pty.openpty()

    def set_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        text=False,
        close_fds=True,
        preexec_fn=set_controlling_tty,
    )
    os.close(slave_fd)
    job.processes.append(ProcessRef(host=host.get("address", ""), command=shell_join(cmd), process=proc))

    host_name = host.get("name") or host.get("address")
    pending = ""
    password_sent = False
    job.log(f"{host_name}: 等待 SSH 连接和认证")
    try:
        while True:
            if job.stop_requested:
                proc.terminate()
                break
            ready, _, _ = select.select([master_fd], [], [], 0.2)
            if ready:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b""
                if data:
                    text = data.decode("utf-8", errors="replace")
                    pending += text
                    if not password_sent and password_prompt_seen(pending):
                        os.write(master_fd, (password + "\n").encode("utf-8"))
                        password_sent = True
                        job.log(f"{host_name}: 已发送 SSH 密码，等待远端命令输出")
                        pending = ""
                    messages, pending = pop_stream_messages(pending)
                    for message in messages:
                        if message and "password:" not in message.lower():
                            job.log(f"{host_name}: {message}")
                            if result_prefix:
                                job.result(f"{result_prefix} {host_name}: {message}")
                            if "Permission denied" in message:
                                job.log(f"{host_name}: SSH 密码认证失败，请确认用户名、密码、SSH 端口以及目标机是否允许 root 密码登录")
                elif proc.poll() is not None:
                    break
            if proc.poll() is not None:
                break
        if pending.strip() and "password:" not in pending.lower():
            job.log(f"{host_name}: {pending.strip()}")
            if result_prefix:
                job.result(f"{result_prefix} {host_name}: {pending.strip()}")
    finally:
        os.close(master_fd)

    code = proc.wait()
    job.log(f"{host_name}: exit {code}")
    return code


def run_subprocess(job: Job, host: dict[str, Any], remote_command: str, wait: bool, result_prefix: str = "") -> int:
    cmd = ssh_command(host, remote_command)
    job.log(f"{host.get('name') or host.get('address')}: {shell_join(cmd)}")
    ssh_password = str(host.get("sshPassword") or "")
    if os.name == "nt" and ssh_password and wait:
        return run_paramiko_stream(job, host, remote_command, result_prefix)
    if ssh_password and wait:
        return run_with_password(job, host, cmd, ssh_password, result_prefix)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    job.processes.append(ProcessRef(host=host.get("address", ""), command=remote_command, process=proc))
    if not wait:
        return 0
    assert proc.stdout is not None
    for line in proc.stdout:
        if job.stop_requested:
            proc.terminate()
            break
        message = line.rstrip()
        job.log(f"{host.get('name') or host.get('address')}: {message}")
        if result_prefix:
            job.result(f"{result_prefix} {host.get('name') or host.get('address')}: {message}")
        if "Permission denied" in message:
            job.log(f"{host.get('name') or host.get('address')}: SSH 认证失败，请确认用户、私钥、公钥授权或目标机是否允许 root 登录")
    code = proc.wait()
    job.log(f"{host.get('name') or host.get('address')}: exit {code}")
    return code


def execute_job(job: Job) -> None:
    try:
        plan = build_plan(job.config)
        job.status = "running"
        persist_jobs_force()
        if job.dry_run:
            job.log("预览模式：不会执行 SSH 命令")
            for pair in plan["pairs"]:
                job.log(f"SERVER {pair['server'].get('name')}: {pair['serverCommand']}")
                job.log(f"CLIENT {pair['client'].get('name')}: {pair['clientCommand']}")
                job.result(f"SERVER {pair['server'].get('name')}: {pair['serverCommand']}")
                job.result(f"CLIENT {pair['client'].get('name')}: {pair['clientCommand']}")
            job.status = "finished"
            persist_jobs_force()
            return

        job.log(f"启动 {len(plan['pairs'])} 条流")
        job.result("等待 perftest 输出...")
        server_threads = []
        server_results = []

        def run_server(pair: dict[str, Any]) -> None:
            code = run_subprocess(job, pair["server"], pair["serverCommand"], True, "SERVER")
            server_results.append((pair["server"].get("name") or pair["server"].get("address"), code))

        for pair in plan["pairs"]:
            if job.stop_requested:
                break
            thread = threading.Thread(target=run_server, args=(pair,))
            thread.start()
            server_threads.append(thread)
        time.sleep(float(job.config.get("serverWarmup", 2)))
        failed_servers = [name for name, code in server_results if code != 0]
        if failed_servers and not job.stop_requested:
            raise RuntimeError(f"server 启动失败，已停止 client 启动：{', '.join(failed_servers)}")

        client_threads = []
        client_results = []

        def run_client(pair: dict[str, Any]) -> None:
            code = run_subprocess(job, pair["client"], pair["clientCommand"], True, "CLIENT")
            client_results.append((pair["client"].get("name") or pair["client"].get("address"), code))

        for pair in plan["pairs"]:
            if job.stop_requested:
                break
            thread = threading.Thread(target=run_client, args=(pair,))
            thread.start()
            client_threads.append(thread)
            time.sleep(float(job.config.get("clientStagger", 0.2)))

        for thread in client_threads:
            thread.join()

        for thread in server_threads:
            thread.join(timeout=5)

        failed_clients = [name for name, code in client_results if code != 0]
        if failed_clients and not job.stop_requested:
            raise RuntimeError(f"client 执行失败：{', '.join(failed_clients)}")
        failed_servers = [name for name, code in server_results if code != 0]
        if failed_servers and not job.stop_requested:
            raise RuntimeError(f"server 执行失败：{', '.join(failed_servers)}")

        job.status = "stopped" if job.stop_requested else "finished"
        if job.stop_requested:
            job.log("任务已手动停止")
        job.log(f"任务{job.status}")
        persist_jobs_force()
    except Exception as exc:
        if job.stop_requested:
            job.status = "stopped"
            job.log("任务已手动停止")
        else:
            job.status = "failed"
            job.log(f"错误：{exc}")
        persist_jobs_force()


def stop_job(job: Job) -> None:
    job.stop_requested = True
    job.log("收到停止请求")
    for ref in job.processes:
        if ref.process and ref.process.poll() is None:
            try:
                if os.name != "nt":
                    try:
                        os.killpg(ref.process.pid, signal.SIGTERM)
                    except OSError:
                        ref.process.send_signal(signal.SIGTERM)
                else:
                    ref.process.send_signal(signal.SIGTERM)
            except OSError:
                pass
    if job.status in {"queued", "running"}:
        job.status = "stopped"
    persist_jobs_force()
    threading.Thread(target=cleanup_remote_processes, args=(job,), daemon=True).start()


def cleanup_remote_processes(job: Job) -> None:
    killed_hosts = {ref.host for ref in job.processes if ref.host}
    pattern = TEST_TO_BINARY.get(job.config.get("testType"), "ib_write_bw")

    def cleanup_host(host: dict[str, Any]) -> None:
        try:
            if os.name == "nt" and host.get("sshPassword"):
                run_paramiko_capture(host, f"pkill -f {shlex.quote(pattern)}", timeout=2)
            else:
                subprocess.run(ssh_command(host, f"pkill -f {shlex.quote(pattern)}"), timeout=2, check=False)
            job.log(f"{host.get('name')}: 已发送 pkill -f {pattern}")
        except Exception as exc:
            job.log(f"{host.get('name')}: 后台停止失败 {exc}")

    threads = []
    for host_addr in killed_hosts:
        matching = [h for h in job.config.get("hosts", []) if h.get("address") == host_addr]
        for host in matching:
            thread = threading.Thread(target=cleanup_host, args=(host,), daemon=True)
            thread.start()
            threads.append(thread)
    for thread in threads:
        thread.join(timeout=3)
    persist_jobs_force()


def scan_local_interfaces() -> list[dict[str, str]]:
    try:
        result = subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, check=True)
        rows = json.loads(result.stdout)
        interfaces = []
        for row in rows:
            addrs = [a.get("local", "") for a in row.get("addr_info", []) if a.get("family") == "inet"]
            interfaces.append({"name": row.get("ifname", ""), "addresses": ", ".join(addrs)})
        return interfaces
    except Exception:
        return []


def parse_ibdev2netdev(output: str) -> dict[str, dict[str, str]]:
    devices: dict[str, dict[str, str]] = {}
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if "==>" not in line:
            continue
        left, right = line.split("==>", 1)
        parts = left.split()
        if not parts:
            continue
        device = parts[0]
        ib_port = ""
        if "port" in parts:
            try:
                ib_port = parts[parts.index("port") + 1]
            except IndexError:
                ib_port = ""
        right_parts = right.strip().split()
        netdev = right_parts[0] if right_parts else ""
        state = right_parts[1].strip("()") if len(right_parts) > 1 else ""
        devices[device] = {"device": device, "netdev": netdev, "state": state, "port": ib_port}
    return devices


def parse_ip_addr(output: str) -> dict[str, list[str]]:
    interfaces: dict[str, list[str]] = {}
    rows = json.loads(output or "[]")
    for row in rows:
        name = row.get("ifname", "")
        addrs = []
        for item in row.get("addr_info", []):
            if item.get("family") == "inet" and item.get("local"):
                addrs.append(item["local"])
        interfaces[name] = addrs
    return interfaces


def scan_remote_interfaces(host: dict[str, Any]) -> dict[str, Any]:
    remote_command = "ip -j addr; echo __ROCE_IBDEV2NETDEV__; ibdev2netdev 2>/dev/null || true"
    code, output = run_ssh_capture(host, remote_command)
    if code != 0:
        raise ValueError(output.strip() or f"{host.get('name') or host.get('address')} 扫描失败")

    ip_text, _, rdma_text = output.partition("__ROCE_IBDEV2NETDEV__")
    interfaces = parse_ip_addr(ip_text.strip())
    rdma_by_device = parse_ibdev2netdev(rdma_text)
    devices = []
    seen_addresses: list[str] = []
    for device, item in rdma_by_device.items():
        addresses = interfaces.get(item.get("netdev", ""), [])
        for address in addresses:
            if address not in seen_addresses:
                seen_addresses.append(address)
        devices.append(
            {
                **item,
                "addresses": addresses,
                "label": " / ".join(part for part in [device, item.get("netdev", ""), ", ".join(addresses)] if part),
            }
        )
    if not devices:
        for netdev, addresses in interfaces.items():
            for address in addresses:
                if address not in seen_addresses:
                    seen_addresses.append(address)
            if addresses:
                devices.append({"device": netdev, "netdev": netdev, "state": "", "port": "", "addresses": addresses, "label": f"{netdev} / {', '.join(addresses)}"})
    return {"devices": devices, "addresses": seen_addresses}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        if parsed.path == "/":
            return str(STATIC_DIR / "index.html")
        if parsed.path.startswith("/static/"):
            return str(ASSET_DIR / parsed.path.lstrip("/"))
        return str(STATIC_DIR / parsed.path.lstrip("/"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/hosts":
            send_json(self, {"hosts": load_hosts()})
            return
        if parsed.path == "/api/hosts/template":
            data = build_hosts_template_xlsx()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="roce-hosts-template.xlsx"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parsed.path == "/api/interfaces/local":
            send_json(self, {"interfaces": scan_local_interfaces()})
            return
        if parsed.path == "/api/jobs":
            with JOBS_LOCK:
                jobs = [
                    {
                        "id": job.id,
                        "createdAt": job.created_at,
                        "status": job.status,
                        "dryRun": job.dry_run,
                        "config": summarize_config(job.config),
                        "logs": job.logs[-20:],
                        "results": job.results[-40:],
                    }
                    for job in JOBS.values()
                ]
                jobs.sort(key=lambda item: item["createdAt"], reverse=True)
            send_json(self, {"jobs": jobs})
            return
        if parsed.path.startswith("/api/jobs/"):
            job_id = parsed.path.rsplit("/", 1)[-1]
            job = JOBS.get(job_id)
            if not job:
                send_json(self, {"error": "job not found"}, 404)
                return
            query = parse_qs(parsed.query)
            try:
                log_limit = max(0, min(600, int((query.get("logs") or ["300"])[0])))
            except ValueError:
                log_limit = 300
            try:
                result_limit = max(0, min(1000, int((query.get("results") or ["500"])[0])))
            except ValueError:
                result_limit = 500
            send_json(
                self,
                {
                    "id": job.id,
                    "createdAt": job.created_at,
                    "status": job.status,
                    "dryRun": job.dry_run,
                    "config": sanitize_config(job.config),
                    "logs": job.logs[-log_limit:] if log_limit else [],
                    "results": job.results[-result_limit:] if result_limit else [],
                },
            )
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = read_json_body(self)
            if parsed.path == "/api/hosts":
                hosts = body.get("hosts", [])
                save_hosts(hosts)
                send_json(self, {"ok": True, "hosts": hosts})
                return
            if parsed.path == "/api/hosts/import-xlsx":
                encoded = str(body.get("contentBase64") or "")
                if "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                if not encoded:
                    raise ValueError("缺少 Excel 文件内容")
                hosts = parse_xlsx_hosts(base64.b64decode(encoded))
                send_json(self, {"ok": True, "hosts": hosts})
                return
            if parsed.path == "/api/hosts/scan":
                host_id = str(body.get("hostId") or "")
                host = next((item for item in load_hosts() if str(item.get("id")) == host_id), None)
                if not host:
                    host = body.get("host")
                if not host:
                    raise ValueError("未找到要扫描的服务器")
                send_json(self, {"ok": True, **scan_remote_interfaces(host)})
                return
            if parsed.path == "/api/hosts/scan-cache":
                host = save_host_scan_cache(
                    str(body.get("hostId") or ""),
                    body.get("scanDevices") or [],
                    body.get("scanAddresses") or [],
                    str(body.get("device") or ""),
                    str(body.get("roceIp") or ""),
                )
                send_json(self, {"ok": True, "host": host})
                return
            if parsed.path == "/api/topology":
                hosts = body.get("hosts", [])
                merged = save_topology(hosts)
                send_json(self, {"ok": True, "hosts": merged})
                return
            if parsed.path == "/api/plan":
                plan = build_plan(body)
                compact = [
                    {
                        "server": p["server"].get("name") or p["server"].get("address"),
                        "client": p["client"].get("name") or p["client"].get("address"),
                        "serverDevice": p["server"].get("device", ""),
                        "clientDevice": p["client"].get("device", ""),
                        "port": p["port"],
                        "serverCommand": p["serverCommand"],
                        "clientCommand": p["clientCommand"],
                    }
                    for p in plan["pairs"]
                ]
                send_json(self, {"pairs": compact})
                return
            if parsed.path == "/api/jobs":
                plan = build_plan(body)
                job_id = uuid.uuid4().hex[:12]
                job = Job(
                    id=job_id,
                    created_at=time.time(),
                    config=body,
                    dry_run=bool(body.get("dryRun", True)),
                )
                with JOBS_LOCK:
                    running_job = active_job()
                    if running_job:
                        raise ValueError(f"已有任务正在运行：{running_job.id}，请先停止或等待完成")
                    JOBS[job_id] = job
                persist_jobs_force()
                thread = threading.Thread(target=execute_job, args=(job,), daemon=True)
                thread.start()
                send_json(self, {"id": job_id, "status": job.status, "pairs": len(plan["pairs"])})
                return
            if parsed.path == "/api/jobs/delete":
                deleted = delete_jobs(body.get("jobIds") or [])
                send_json(self, {"ok": True, "deleted": deleted})
                return
            if parsed.path.startswith("/api/jobs/") and parsed.path.endswith("/rerun"):
                job_id = parsed.path.split("/")[-2]
                source_job = JOBS.get(job_id)
                if not source_job:
                    send_json(self, {"error": "job not found"}, 404)
                    return
                config = rehydrate_job_config(source_job.config)
                plan = build_plan(config)
                new_job_id = uuid.uuid4().hex[:12]
                job = Job(
                    id=new_job_id,
                    created_at=time.time(),
                    config=config,
                    dry_run=False,
                )
                with JOBS_LOCK:
                    running_job = active_job()
                    if running_job:
                        raise ValueError(f"已有任务正在运行：{running_job.id}，请先停止或等待完成")
                    JOBS[new_job_id] = job
                persist_jobs_force()
                thread = threading.Thread(target=execute_job, args=(job,), daemon=True)
                thread.start()
                send_json(self, {"id": new_job_id, "status": job.status, "pairs": len(plan["pairs"])})
                return
            if parsed.path.startswith("/api/jobs/") and parsed.path.endswith("/stop"):
                job_id = parsed.path.split("/")[-2]
                job = JOBS.get(job_id)
                if not job:
                    send_json(self, {"error": "job not found"}, 404)
                    return
                stop_job(job)
                send_json(self, {"ok": True, "status": job.status})
                return
            send_json(self, {"error": "not found"}, 404)
        except Exception as exc:
            send_json(self, {"error": str(exc)}, 400)


def main() -> None:
    ensure_data()
    load_jobs()
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"RoCE Batch Traffic Console: {url}")
    if os.environ.get("ROCE_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
