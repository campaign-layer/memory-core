#!/usr/bin/env python3
"""Credential-free L2 probes through real AutoGen and CrewAI MCP hosts."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request
import uuid


EXPECTED_TOOLS = [
    "build_context",
    "feedback",
    "forget",
    "recall",
    "remember",
    "supersede",
]


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def principal_for(app_id: str) -> dict[str, str]:
    principal = json.loads(required("BENCH_PRINCIPAL_JSON"))
    if principal["appId"] != app_id:
        raise RuntimeError(
            f"probe principal appId={principal['appId']} does not match {app_id}"
        )
    return principal


def child_env(app_id: str) -> dict[str, str]:
    principal = principal_for(app_id)
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "MEMORY_CORE_MODE": "remote",
        "MEMORY_CORE_URL": required("MC_BASE_URL"),
        "MEMORY_CORE_API_KEY": principal["key"],
        "MEMORY_TENANT_ID": principal["tenantId"],
        "MEMORY_SPACE_ID": principal["spaceId"],
        "MEMORY_APP_ID": principal["appId"],
        "MEMORY_ACTOR_ID": principal["actorId"],
        "MEMORY_THREAD_ID": f"framework-probe-{app_id}",
        "MEMORY_SOURCE_TYPE": f"framework-probe:{app_id}",
    }


def text_of(value: object) -> str:
    if isinstance(value, str):
        return value
    to_text = getattr(value, "to_text", None)
    if callable(to_text):
        return str(to_text())
    if isinstance(value, list):
        return "\n".join(text_of(item) for item in value)
    if isinstance(value, dict):
        content = value.get("content")
        return text_of(content) if content is not None else json.dumps(value, default=str)
    content = getattr(value, "content", None)
    if content is not None:
        return text_of(content)
    text = getattr(value, "text", None)
    if text is not None:
        return str(text)
    return str(value)


def memory_id(value: object, label: str) -> str:
    match = re.search(r"id=(\S+)", text_of(value))
    if not match:
        raise RuntimeError(f"{label} did not return an id")
    return match.group(1)


def ensure_tool_success(value: object, label: str) -> None:
    if bool(getattr(value, "is_error", False)) or re.search(
        r"failed|error", text_of(value), re.IGNORECASE
    ):
        raise RuntimeError(f"{label} returned an error")


def attest_installed_versions(
    packages: list[str], expected_version_env: str
) -> list[dict[str, object]]:
    expected = required(expected_version_env)
    attestations: list[dict[str, object]] = []
    for package in packages:
        actual = importlib.metadata.version(package)
        if actual != expected:
            raise RuntimeError(
                f"{package} installed version {actual} does not match "
                f"{expected_version_env}={expected}"
            )
        attestations.append({
            "package": package,
            "actual": actual,
            "expected": expected,
            "expectedFrom": expected_version_env,
            "matched": True,
        })
    return attestations


def get_remote_memory(app_id: str, memory_id_value: str) -> object | None:
    principal = principal_for(app_id)
    request = urllib.request.Request(
        f"{required('MC_BASE_URL').rstrip('/')}/v1/memory/get",
        data=json.dumps(
            {
                "memoryId": memory_id_value,
                "tenantId": principal["tenantId"],
                "spaceId": principal["spaceId"],
                "appId": principal["appId"],
                "actorId": principal["actorId"],
            }
        ).encode(),
        headers={"content-type": "application/json", "x-api-key": principal["key"]},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"REST lifecycle check returned {response.status}")
        return json.loads(response.read()).get("memory")


async def exercise(
    framework: str,
    version: str,
    version_attestation: list[dict[str, object]],
    names: list[str],
    call,
) -> dict[str, object]:
    started_at = now()
    old_id: str | None = None
    replacement_id: str | None = None
    cleanup_completed = False
    try:
        if sorted(names) != EXPECTED_TOOLS:
            raise RuntimeError(f"tool surface mismatch: got {','.join(sorted(names))}")

        malformed_rejected = False
        try:
            malformed = await call("remember", {"text": "no"})
            malformed_rejected = bool(getattr(malformed, "is_error", False)) or bool(
                re.search(r"failed|invalid|at least", text_of(malformed), re.IGNORECASE)
            )
        except Exception:  # host adapters may raise a typed tool-validation error
            malformed_rejected = True
        if not malformed_rejected:
            raise RuntimeError("malformed remember input was not rejected")

        marker = f"compat-{framework}-{int(time.time() * 1000)}-{uuid.uuid4()}"
        remembered = await call("remember", {
            "text": f"Framework {framework} remembers marker {marker}",
            "type": "tool_outcome",
            "scope": "actor",
            "importance": 0.8,
        })
        old_id = memory_id(remembered, "remember")
        old_memory = await asyncio.to_thread(get_remote_memory, framework, old_id)
        if not isinstance(old_memory, dict) or old_memory.get("id") != old_id:
            raise RuntimeError("remembered id was not readable through REST")
        recalled = text_of(await call("recall", {"query": marker, "limit": 5}))
        if marker not in recalled:
            raise RuntimeError("recall did not return the marker")
        context = text_of(await call("build_context", {
            "query": marker,
            "maxItems": 5,
            "maxChars": 1000,
        }))
        if marker not in context:
            raise RuntimeError("build_context did not return the marker")
        ensure_tool_success(
            await call("feedback", {"memoryId": old_id, "signal": "useful"}),
            "feedback",
        )

        replacement = f"{marker}-corrected"
        superseded = await call("supersede", {
            "memoryId": old_id,
            "newText": f"Framework {framework} corrected marker {replacement}",
            "reason": "compatibility probe",
        })
        replacement_id = memory_id(superseded, "supersede")
        old_after = await asyncio.to_thread(get_remote_memory, framework, old_id)
        replacement_memory = await asyncio.to_thread(
            get_remote_memory, framework, replacement_id
        )
        if old_after is not None:
            raise RuntimeError("superseded id remained active through REST")
        if (
            not isinstance(replacement_memory, dict)
            or replacement_memory.get("id") != replacement_id
        ):
            raise RuntimeError("replacement id was not active through REST")
        corrected = text_of(await call("recall", {"query": replacement, "limit": 5}))
        if replacement not in corrected:
            raise RuntimeError("corrected memory was not recalled")
        forgotten = await call("forget", {
            "memoryId": replacement_id,
            "reason": "compatibility probe cleanup",
        })
        ensure_tool_success(forgotten, "forget")
        after_forget = text_of(await call("recall", {"query": replacement, "limit": 5}))
        if replacement in after_forget:
            raise RuntimeError("forgotten memory remained visible")
        if await asyncio.to_thread(get_remote_memory, framework, replacement_id) is not None:
            raise RuntimeError("forgotten id remained active through REST")
        cleanup_completed = True

        return {
            "framework": framework,
            "version": version,
            "versionAttestation": version_attestation,
            "level": "L2",
            "passed": True,
            "startedAt": started_at,
            "finishedAt": now(),
            "tools": sorted(names),
            "checks": [
                "installed-version-attestation",
                "list-tools",
                "malformed-input",
                "remember",
                "recall",
                "build-context",
                "feedback",
                "supersede",
                "forget",
                "rest-lifecycle-corroboration",
            ],
        }
    finally:
        if not cleanup_completed:
            cleanup_ids = list(dict.fromkeys(
                item for item in (replacement_id, old_id) if item is not None
            ))
            for cleanup_id in cleanup_ids:
                try:
                    await call("forget", {
                        "memoryId": cleanup_id,
                        "reason": "compatibility probe failure cleanup",
                    })
                except Exception:  # preserve the original probe failure
                    pass


async def autogen_probe(server_path: Path) -> dict[str, object]:
    version_attestation = attest_installed_versions(
        ["autogen-agentchat", "autogen-ext"], "AUTOGEN_EXPECTED_VERSION"
    )
    from autogen_ext.tools.mcp import McpWorkbench, StdioServerParams

    params = StdioServerParams(
        command=required("NODE_BIN"),
        args=[str(server_path)],
        env=child_env("autogen"),
        read_timeout_seconds=30,
    )
    async with McpWorkbench(server_params=params) as workbench:
        tools = await workbench.list_tools()

        async def call(name: str, args: dict[str, object]) -> object:
            return await workbench.call_tool(name, args)

        return await exercise(
            "autogen",
            f"autogen-ext@{version_attestation[1]['actual']}",
            version_attestation,
            [tool["name"] for tool in tools],
            call,
        )


async def crewai_probe(server_path: Path) -> dict[str, object]:
    version_attestation = attest_installed_versions(
        ["crewai", "crewai-tools"], "CREWAI_EXPECTED_VERSION"
    )
    from crewai_tools import MCPServerAdapter
    from mcp import StdioServerParameters

    params = StdioServerParameters(
        command=required("NODE_BIN"),
        args=[str(server_path)],
        env=child_env("crewai"),
    )
    with MCPServerAdapter(params, connect_timeout=30) as tools:
        by_name = {tool.name: tool for tool in tools}

        async def call(name: str, args: dict[str, object]) -> object:
            tool = by_name.get(name)
            if tool is None:
                raise RuntimeError(f"CrewAI did not expose {name}")
            return tool.run(**args)

        return await exercise(
            "crewai",
            f"crewai-tools@{version_attestation[1]['actual']}",
            version_attestation,
            list(by_name),
            call,
        )


def now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"autogen", "crewai"}:
        raise RuntimeError("usage: probe-python.py autogen|crewai")
    framework = sys.argv[1]
    root = Path(os.environ.get("MEMORY_CORE_ROOT", Path(__file__).resolve().parents[2]))
    server_path = root / "dist" / "integrations" / "mcp-server.js"
    result = await (autogen_probe(server_path) if framework == "autogen" else crewai_probe(server_path))
    print(f"@@MEMORY_CORE_PROBE@@{json.dumps(result, separators=(',', ':'))}")


if __name__ == "__main__":
    framework_name = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    try:
        asyncio.run(main())
    except Exception as error:  # noqa: BLE001 - the probe must emit one machine-readable result
        failure = {
            "framework": framework_name,
            "level": "L0",
            "passed": False,
            "finishedAt": now(),
            "error": str(error),
        }
        print(f"@@MEMORY_CORE_PROBE@@{json.dumps(failure, separators=(',', ':'))}")
        raise SystemExit(1) from error
