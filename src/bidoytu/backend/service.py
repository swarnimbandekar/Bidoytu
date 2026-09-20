"""Application use cases shared by all desktop IPC commands."""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import time
import uuid
import errno
from dataclasses import asdict
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx

from bidoytu.audit.service import LiveAuditService
from bidoytu.collaborator.service import CollaboratorService, OAST_SERVERS
from bidoytu.config import AppConfig, host_matches_scope
from bidoytu.http_utils import parse_request_text
from bidoytu.storage.advanced_history import filter_spec_from_dict
from bidoytu.storage.models import FlowRecord
from bidoytu.proxy.engine import ProxyService
from bidoytu.browser_integration import discover_browsers, launch_browser, stop_browser
from bidoytu.net.attack import (
    ATTACK_TYPES,
    BATTERING_RAM,
    MARKER as PAYLOAD_MARKER,
    PayloadSet,
    SNIPER,
    count_jobs,
    find_markers,
    iter_jobs,
)
from bidoytu.net.payloads import GEN_LIST, GeneratorSpec
from .storage import Storage, summary


class ApplicationService:
    def __init__(self, data_dir: Path, emit, ca_dir: Path | None = None):
        self.config = AppConfig(data_dir=data_dir, ca_dir=ca_dir)
        self.config.ensure_dirs()
        self.config.load_proxy_scope()
        self.storage = Storage(self.config)
        self.emit = emit
        self.proxy = ProxyService(self.config, self.capture, self.intercept, self.changed)
        self.pending: dict[str, dict] = {}
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self.queue_bytes = 0
        self.dropped = 0
        self.dirty = False
        self.audit = LiveAuditService()
        self.audit.set_enabled(False)
        self.audit_enabled = False
        self.collaborator = CollaboratorService(self.changed, not self.config.proxy.ssl_insecure)
        self.findings: dict[str, dict] = {}
        self.clients: dict[bool, httpx.AsyncClient] = {}
        # Intruder attacks are keyed by attack id so minimized tabs can keep
        # running while another tab starts an independent attack.
        self.jobs: dict[str, asyncio.Task] = {}
        # Slots are allocated by the producer and filled by concurrent workers.
        # This preserves payload order without serialising network requests.
        self.job_results: dict[str, list[dict | None]] = {}
        self.job_states: dict[str, str] = {}
        self.last_attack_id: str | None = None
        self.job_state = "idle"
        self.error = ""
        # Repeater still shares this pool, while Intruder applies its own
        # per-run worker limit. Keep the transport pool high enough that the
        # Intruder setting is meaningful instead of silently capping at 8.
        self.network_slots = asyncio.Semaphore(64)
        self.browsers = discover_browsers()
        self.browser_processes = []

    async def open(self):
        await self.storage.open()
        self.writer = asyncio.create_task(self._persist())
        self.notifier = asyncio.create_task(self._notify())
        try:
            await self.proxy.start(self.config.proxy.listen_port, not self.config.proxy.ssl_insecure)
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, 10048):
                self.error = f"Proxy port {self.config.proxy.listen_port} is already in use. Choose another port in Settings."
            else:
                self.error = f"Proxy could not start: {exc}"
        except Exception as exc:
            self.error = f"Proxy could not start: {exc}"

    def changed(self):
        self.dirty = True

    def state(self):
        return {"protocol": 1, "running": self.proxy.running,
                "port": self.config.proxy.listen_port, "host": "127.0.0.1",
                "intercept": self.proxy.enabled, "responses": self.proxy.responses,
                "pending": list(self.pending.values()), "audit": self.audit_enabled,
                "findings": len(self.findings), "dropped": self.dropped,
                "queue_depth": self.queue.qsize(), "error": self.proxy.error or self.error,
                "data_dir": str(self.config.data_dir),
                "scope": {"include": self.config.proxy.include_scope,
                          "exclude": self.config.proxy.exclude_scope},
                "job_state": self.job_state}

    def capture(self, record: FlowRecord, response: bool):
        size = len(record.request_body_inline or b"") + len(record.response_body_inline or b"")
        if self.queue.full() or self.queue_bytes + size > 64 * 1024 * 1024:
            self.dropped += 1
            self.changed()
            return
        self.queue_bytes += size
        self.queue.put_nowait((copy.copy(record), response, size))

    def intercept(self, record: FlowRecord, phase: str):
        if phase == "response":
            self.capture(record, False)
        # Limit paused requests so an unattended UI cannot consume unbounded RAM.
        if len(self.pending) >= 100:
            resolver = self.proxy.addon.resolve if phase == "request" else self.proxy.addon.resolve_response
            resolver(record.flow_id, True, None)
            self.error = "Intercept queue reached 100 items; additional paused traffic was dropped."
        else:
            self.pending[record.flow_id] = {**summary(record), "phase": phase}
        self.changed()

    async def _persist(self):
        while True:
            record, response, size = await self.queue.get()
            try:
                if self.audit_enabled and record.scope and response:
                    _, issues = await self.storage.call(self.audit.analyze, record, response)
                    for issue in issues:
                        key = f"{record.host}:{issue.title}"
                        self.findings[key] = {"id": key, "flow_id": record.flow_id,
                            "title": issue.title, "severity": str(issue.severity),
                            "detail": issue.detail, "remediation": issue.remediation,
                            "url": record.url, "evidence": [asdict(e) for e in issue.evidence]}
                    while len(self.findings) > 2000:
                        self.findings.pop(next(iter(self.findings)))
                await self.storage.call(self.storage.save, record)
            except Exception as exc:
                self.error = f"Storage: {exc}"
            finally:
                self.queue_bytes -= size
                self.queue.task_done()
                self.changed()

    async def _notify(self):
        while True:
            await asyncio.sleep(0.2)
            if self.dirty:
                self.dirty = False
                await self.emit({"event": "changed", "data": self.state()})

    async def send(self, params: dict, tool="Repeater"):
        raw = str(params.get("request", ""))
        if not raw.strip() or len(raw) > 1024 * 1024:
            raise ValueError("Provide a request smaller than 1 MiB")
        parsed = parse_request_text(raw)
        target = urlsplit(str(params.get("url", "")))
        if target.scheme not in ("http", "https") or not target.hostname or target.username:
            raise ValueError("Target must be an HTTP or HTTPS URL without credentials")
        path = parsed.path
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Request target must be an origin path starting with /")
        url = f"{target.scheme}://{target.netloc}{path}"
        verify = bool(params.get("verify_tls", True))
        client = self.clients.get(verify)
        if client is None:
            client = self.clients[verify] = httpx.AsyncClient(
                verify=verify, trust_env=False, timeout=30,
                limits=httpx.Limits(max_connections=64, max_keepalive_connections=32))
        headers = [(k, v) for k, v in parsed.headers if k.lower() not in
                   {"content-length", "connection", "transfer-encoding", "accept-encoding"}]
        record = FlowRecord(flow_id=str(uuid.uuid4()), method=parsed.method,
            scheme=target.scheme, host=target.hostname, port=target.port or (443 if target.scheme == "https" else 80),
            path=path, http_version=parsed.http_version,
            request_headers="\r\n".join(f"{k}: {v}" for k, v in headers),
            request_body_inline=parsed.body, request_body_size=len(parsed.body),
            started_at=time.time(), tool=tool)
        record.scope = host_matches_scope(record.host, self.config.proxy.include_scope, self.config.proxy.exclude_scope, record.path)
        async with self.network_slots:
            async with client.stream(parsed.method, url, headers=headers, content=parsed.body) as response:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 32 * 1024 * 1024:
                        raise ValueError("Response exceeds the 32 MiB capture limit")
                record.status_code = response.status_code
                record.reason = response.reason_phrase
                record.http_version = response.http_version
                record.response_headers = "\r\n".join(f"{k}: {v}" for k, v in response.headers.multi_items())
                record.response_body_inline = bytes(body)
                record.response_body_size = len(body)
                record.content_type = response.headers.get("content-type", "")
                record.completed_at = time.time()
        await self.storage.call(self.storage.save, record)
        self.changed()
        return await self.storage.call(self.storage.detail, record.flow_id)

    async def _run_job(self, params: dict):
        attack_id = str(params["attack_id"])
        self.job_states[attack_id] = "running"
        self.job_results[attack_id] = []
        self.job_state = "running"
        self.changed()
        # A payload position is any span between a pair of § markers. The attack
        # type decides how the configured payload sets are combined across those
        # positions (sniper / battering ram / pitchfork / cluster bomb); the
        # engine in bidoytu.net.attack yields one fully-substituted request per
        # job. Each set is a plain list of strings materialised by the frontend.
        clean_text, markers = find_markers(str(params["request"]))
        attack_type = str(params.get("attack_type", BATTERING_RAM))
        sets = [
            PayloadSet(generator=GeneratorSpec(kind=GEN_LIST, items=list(values)))
            for values in params["_payload_sets"]
        ]
        concurrency = max(1, min(64, int(params.get("concurrency", 10))))
        queue: asyncio.Queue = asyncio.Queue(maxsize=concurrency * 2)
        workers: list[asyncio.Task] = []

        async def produce():
            for job in iter_jobs(clean_text, markers, attack_type, sets):
                # Reserve the result position before yielding to the bounded
                # queue. Workers may finish out of order, but presentation and
                # exports must always follow the generated payload sequence.
                self.job_results[attack_id].append(None)
                await queue.put(job)
            # Only publish sentinels after the complete job stream has been
            # queued. On cancellation the producer is cancelled directly and
            # must not block trying to enqueue cleanup markers with no workers.
            for _ in range(concurrency):
                await queue.put(None)

        async def worker():
            while True:
                job = await queue.get()
                try:
                    if job is None:
                        return
                    index = job.index + 1
                    payloads = list(job.payloads)
                    payload = " | ".join(payloads)
                    try:
                        result = await self.send({**params, "request": job.request_text}, "Intruder")
                        self.job_results[attack_id][job.index] = {
                            "index": index, "payload": payload, "payloads": payloads,
                            **summary_from_detail(result)}
                    except Exception as exc:
                        self.job_results[attack_id][job.index] = {
                            "index": index, "payload": payload, "payloads": payloads,
                            "error": str(exc)}
                    self.changed()
                finally:
                    queue.task_done()

        try:
            producer = asyncio.create_task(produce())
            workers = [asyncio.create_task(worker()) for _ in range(concurrency)]
            await producer
            await queue.join()
            await asyncio.gather(*workers)
            self.job_states[attack_id] = "complete"
        except asyncio.CancelledError:
            for task in [*workers, locals().get("producer")]:
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            self.job_states[attack_id] = "cancelled"
            raise
        finally:
            self.jobs.pop(attack_id, None)
            self.job_state = "running" if any(
                value == "running" for value in self.job_states.values()
            ) else self.job_states.get(attack_id, "idle")
            self.changed()

    async def dispatch(self, method: str, p: dict):
        if method == "state":
            return self.state()
        if method == "workspace.load":
            path = self.config.data_dir / "desktop-session.json"
            try:
                return json.loads(await self.storage.call(path.read_text, "utf-8"))
            except (OSError, ValueError):
                return {}
        if method == "workspace.save":
            # Only this fixed workspace file is writable through session IPC.
            encoded = json.dumps(p, ensure_ascii=True)
            if len(encoded) > 1024 * 1024:
                raise ValueError("Workspace session exceeds 1 MiB; close unused request tabs")
            def save_session():
                path = self.config.data_dir / "desktop-session.json"
                temporary = path.with_suffix(".tmp")
                temporary.write_text(encoded, encoding="utf-8")
                temporary.replace(path)
            await self.storage.call(save_session)
            return True
        if method == "history.list":
            raw_filter = p.get("filter")
            spec = filter_spec_from_dict(raw_filter) if isinstance(raw_filter, dict) else None
            return await self.storage.call(self.storage.history, str(p.get("query", ""))[:512],
                max(0, int(p.get("offset", 0))), min(250, max(1, int(p.get("limit", 100)))),
                bool(p.get("scope")), bool(p.get("bookmarked")), spec,
                str(p.get("sort_by", "id")), str(p.get("sort_direction", "desc")))
        if method == "history.detail":
            await self.queue.join()
            return await self.storage.call(self.storage.detail, str(p["flow_id"]))
        if method == "history.clear":
            await self.queue.join()
            await self.storage.call(self.storage.clear_history)
            self.changed()
            return True
        if method == "history.metadata":
            await self.storage.call(self.storage.metadata, str(p["flow_id"]), bool(p["bookmarked"]), str(p.get("notes", ""))[:10000])
            self.changed()
            return True
        if method == "proxy.start":
            port = int(p.get("port", 8080))
            if not 1024 <= port <= 65535:
                raise ValueError("Use a listener port between 1024 and 65535")
            try:
                await self.proxy.start(port, bool(p.get("verify_tls", True)))
            except OSError as exc:
                if exc.errno in (errno.EADDRINUSE, 10048):
                    raise ValueError(f"Proxy port {port} is already in use. Choose another port in Settings.") from exc
                raise
            return self.state()
        if method == "proxy.stop":
            await self.proxy.stop()
            self.pending.clear()
            return self.state()
        if method == "proxy.intercept":
            self.proxy.enabled = bool(p["enabled"])
            self.proxy.responses = bool(p.get("responses", False))
            if self.proxy.addon:
                self.proxy.addon.set_intercept_responses(self.proxy.responses)
                self.proxy.addon.set_intercept_enabled(self.proxy.enabled)
            if not self.proxy.enabled:
                self.pending.clear()
            self.changed()
            return self.state()
        if method == "proxy.resolve":
            flow_id = str(p["flow_id"])
            item = self.pending.get(flow_id)
            if item is None or self.proxy.addon is None:
                raise ValueError("This interception is no longer pending")
            resolver = self.proxy.addon.resolve if item["phase"] == "request" else self.proxy.addon.resolve_response
            resolver(flow_id, bool(p.get("drop")), p.get("edited_text"))
            del self.pending[flow_id]
            self.changed()
            return self.state()
        if method == "scope.save":
            for key in ("include", "exclude"):
                values = p.get(key, [])
                if not isinstance(values, list) or len(values) > 200 or any(not isinstance(v, str) or len(v) > 253 for v in values):
                    raise ValueError("Scope must contain at most 200 host patterns")
                setattr(self.config.proxy, f"{key}_scope", values)
            await self.storage.call(self.config.save_proxy_scope)
            if self.proxy.addon:
                self.proxy.addon.set_scope(self.config.proxy.include_scope, self.config.proxy.exclude_scope)
            self.changed()
            return self.state()
        if method == "repeater.send":
            return await self.send(p)
        if method == "intruder.start":
            _, markers = find_markers(str(p.get("request", "")))
            if not markers:
                raise ValueError("Mark at least one payload position with § markers")
            attack_type = str(p.get("attack_type", BATTERING_RAM))
            if attack_type not in ATTACK_TYPES:
                raise ValueError("Unknown attack type")
            # Accept the new per-position `sets` (list of string lists) and fall
            # back to a single flat `payloads` list (legacy battering ram).
            raw_sets = p.get("sets")
            if raw_sets is None:
                raw_sets = [p.get("payloads", [])]
            if not isinstance(raw_sets, list) or not raw_sets:
                raise ValueError("Provide at least one payload set")

            def _clean(values):
                if not isinstance(values, list) or any(
                    not isinstance(v, str) or len(v) > 4096 for v in values
                ):
                    raise ValueError("Each payload must be text up to 4096 characters")
                return values

            sets = [_clean(values) for values in raw_sets]
            if any(len(values) == 0 for values in sets):
                raise ValueError("Every payload set needs at least one value")
            # Sniper and battering ram only ever consume the first set.
            if attack_type in (SNIPER, BATTERING_RAM):
                sets = sets[:1]

            try:
                concurrency = int(p.get("concurrency", 10))
            except (TypeError, ValueError):
                raise ValueError("Concurrency must be an integer between 1 and 64") from None
            if not 1 <= concurrency <= 64:
                raise ValueError("Concurrency must be between 1 and 64")

            total = count_jobs(attack_type, markers, [
                PayloadSet(generator=GeneratorSpec(kind=GEN_LIST, items=values))
                for values in sets
            ])
            if total is not None and total > 100000:
                raise ValueError(
                    f"This configuration would send {total:,} requests. "
                    "Reduce your payload sets (limit 100,000).")

            attack_id = str(p.get("attack_id") or uuid.uuid4().hex)
            if attack_id in self.jobs:
                raise ValueError("This Intruder attack is already running")
            p = {
                **p,
                "attack_type": attack_type,
                "_payload_sets": sets,
                "concurrency": concurrency,
                "attack_id": attack_id,
            }
            self.job_states[attack_id] = "queued"
            self.last_attack_id = attack_id
            self.job_state = "running"
            self.jobs[attack_id] = asyncio.create_task(self._run_job(p))
            return {"attack_id": attack_id}
        if method == "intruder.results":
            attack_id = str(p.get("attack_id", ""))
            if not attack_id:
                attack_id = self.last_attack_id or (next(iter(self.job_states)) if len(self.job_states) == 1 else "")
            if attack_id not in self.job_states:
                raise ValueError("Unknown Intruder attack")
            return {
                "state": self.job_states[attack_id],
                # A running job can have reserved positions not yet completed.
                # Omit those placeholders while retaining deterministic order.
                "items": [item for item in self.job_results.get(attack_id, []) if item is not None],
            }
        if method == "intruder.cancel":
            attack_id = str(p.get("attack_id", ""))
            if not attack_id:
                attack_id = self.last_attack_id or (next(iter(self.jobs)) if len(self.jobs) == 1 else "")
            if task := self.jobs.get(attack_id):
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            elif attack_id in self.job_states and self.job_states[attack_id] == "running":
                self.job_states[attack_id] = "cancelled"
            return True
        if method == "audit.toggle":
            self.audit_enabled = bool(p["enabled"])
            await self.storage.call(self.audit.set_enabled, self.audit_enabled)
            self.changed()
            return self.state()
        if method == "audit.list":
            return list(self.findings.values())
        if method == "decoder.transform":
            value = str(p.get("text", ""))
            transforms = {
                "base64.encode": lambda: base64.b64encode(value.encode()).decode(),
                "base64.decode": lambda: base64.b64decode(value, validate=True).decode(),
                "url.encode": lambda: quote(value, safe=""), "url.decode": lambda: unquote(value),
                "json.format": lambda: json.dumps(json.loads(value), indent=2, ensure_ascii=False),
                "hex.encode": lambda: value.encode().hex(),
                "hex.decode": lambda: bytes.fromhex(value).decode(),
            }
            if p.get("operation") not in transforms:
                raise ValueError("Unknown transformation")
            return transforms[p["operation"]]()
        if method == "certificate.read":
            if not self.config.ca_cert_pem.exists():
                raise ValueError("Start the proxy once to generate its public CA certificate")
            return await self.storage.call(self.config.ca_cert_pem.read_text)
        if method == "browser.list":
            return [{"id": index, "name": browser.name, "kind": browser.kind}
                    for index, browser in enumerate(self.browsers)]
        if method == "browser.open":
            if not self.proxy.running:
                raise ValueError("Start the proxy before opening a browser")
            try:
                index = int(p.get("id", -1))
                browser = self.browsers[index]
            except (ValueError, IndexError):
                raise ValueError("That browser is no longer available") from None
            profile_name = browser.name.lower().replace(" ", "-")
            profile = self.config.browser_profiles_dir / f"{index}-{profile_name}"
            process, trust_method = await asyncio.to_thread(
                launch_browser, browser, self.config.proxy.listen_host,
                self.config.proxy.listen_port, profile,
                self.config.ca_cert_pem, self.config.ca_cert_cer)
            self.browser_processes.append(process)
            return {"name": browser.name, "trust_method": trust_method}
        if method == "browser.stop":
            # Terminate every browser this session launched and wait for the
            # processes to release their profile files. The desktop host calls
            # this before removing a session directory so Windows does not fail
            # to unlink locked SQLite files (EBUSY).
            await self._stop_browsers()
            return True
        if method == "collaborator.servers":
            return {"servers": list(OAST_SERVERS), "status": self.collaborator.status()}
        if method == "collaborator.register":
            server = str(p.get("server", "")).strip()[:253]
            token = str(p.get("token", "")).strip()
            return await self.collaborator.register(server, token)
        if method == "collaborator.generate":
            return self.collaborator.generate_domain()
        if method == "collaborator.poll":
            return await self.collaborator.poll_now()
        if method == "collaborator.status":
            return self.collaborator.status()
        if method == "collaborator.interactions":
            return {"items": self.collaborator.interactions, "status": self.collaborator.status()}
        if method == "collaborator.clear":
            self.collaborator.clear()
            return self.collaborator.status()
        if method == "collaborator.stop":
            return await self.collaborator.stop()
        raise ValueError(f"Unknown method: {method}")

    async def _stop_browsers(self):
        await asyncio.gather(*(asyncio.to_thread(stop_browser, process)
                               for process in self.browser_processes), return_exceptions=True)
        self.browser_processes.clear()

    async def close(self):
        for task in self.jobs.values():
            task.cancel()
        await asyncio.gather(*self.jobs.values(), return_exceptions=True)
        await self.collaborator.close()
        await self.proxy.stop()
        await self._stop_browsers()
        await self.queue.join()
        self.writer.cancel()
        self.notifier.cancel()
        await asyncio.gather(self.writer, self.notifier, return_exceptions=True)
        await asyncio.gather(*(client.aclose() for client in self.clients.values()))
        await self.storage.close()


def summary_from_detail(value: dict):
    return {key: value[key] for key in ("flow_id", "status_code", "duration_ms", "response_body_size")}
