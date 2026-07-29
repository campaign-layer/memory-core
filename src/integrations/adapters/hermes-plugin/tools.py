"""memory-core tool handlers for Hermes Agent.

Talks to a running memory-core HTTP service over stdlib urllib - no third-party
deps. Handler contract per Hermes docs: take (args: dict, **kwargs), always
return a JSON string, never raise.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

TIMEOUT_SECONDS = 20
_TYPE_MAP = {"used": "selected", "useful": "positive", "not_useful": "negative"}


class ConfigError(RuntimeError):
    pass


def _identity() -> dict[str, str]:
    missing = [
        key
        for key in ("MEMORY_TENANT_ID", "MEMORY_APP_ID", "MEMORY_ACTOR_ID")
        if not os.environ.get(key)
    ]
    if missing:
        raise ConfigError(
            "missing env: %s - memory-core needs an explicit tenant/app/actor so "
            "writes cannot land in the wrong tenant" % ", ".join(missing)
        )
    identity = {
        "tenantId": os.environ["MEMORY_TENANT_ID"],
        "appId": os.environ["MEMORY_APP_ID"],
        "actorId": os.environ["MEMORY_ACTOR_ID"],
    }
    thread_id = os.environ.get("MEMORY_THREAD_ID")
    if thread_id:
        identity["threadId"] = thread_id
    return identity


def _request(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    base = os.environ.get("MEMORY_CORE_URL")
    if not base:
        raise ConfigError("MEMORY_CORE_URL is not set")
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json"},
    )
    api_key = os.environ.get("MEMORY_CORE_API_KEY")
    if api_key:
        request.add_header("x-api-key", api_key)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def _ok(**fields: Any) -> str:
    return json.dumps(fields)


def _err(message: str) -> str:
    return json.dumps({"error": message})


def _guard(fn):
    """Never raise out of a handler - Hermes requires a JSON string either way."""

    def wrapped(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
        try:
            return fn(args or {}, **kwargs)
        except ConfigError as exc:
            return _err(str(exc))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:400]
            return _err("memory-core returned HTTP %s: %s" % (exc.code, body))
        except urllib.error.URLError as exc:
            return _err("cannot reach memory-core: %s" % exc.reason)
        except Exception as exc:  # noqa: BLE001 - contract forbids raising
            return _err("%s: %s" % (type(exc).__name__, exc))

    wrapped.__name__ = fn.__name__
    return wrapped


def _observation(text: str, memory_type: str, importance: float, scope: str, metadata=None) -> dict:
    identity = _identity()
    return {
        **identity,
        "memoryType": memory_type,
        "scope": scope,
        "text": text,
        "importance": importance,
        "metadata": metadata or {},
        "source": {
            "sourceType": "hermes-agent",
            "sourceSessionId": identity.get("threadId"),
        },
    }


def _filters() -> dict:
    identity = _identity()
    return {
        "tenantId": identity["tenantId"],
        "appId": identity["appId"],
        "actorId": identity["actorId"],
    }


@_guard
def remember(args: dict, **_: Any) -> str:
    text = (args.get("text") or "").strip()
    if len(text) < 4:
        return _err("text must be at least 4 characters")
    observation = _observation(
        text,
        args.get("type") or "fact",
        float(args.get("importance", 0.5)),
        args.get("scope") or "actor",
    )
    result = _request("/v1/memory/ingest", {"observations": [observation]})
    records = result.get("records") or [{}]
    return _ok(
        stored=True,
        id=records[0].get("id"),
        created=result.get("created", 0),
        merged=result.get("updated", 0),
    )


@_guard
def recall(args: dict, **_: Any) -> str:
    query = (args.get("query") or "").strip()
    if len(query) < 2:
        return _err("query must be at least 2 characters")
    payload: dict[str, Any] = {
        "query": query,
        "filters": _filters(),
        "limit": int(args.get("limit", 6)),
    }
    if args.get("types"):
        payload["filters"]["memoryTypes"] = args["types"]
    hits = _request("/v1/memory/search", payload).get("hits") or []
    return _ok(
        count=len(hits),
        memories=[
            {
                "id": hit["memory"]["id"],
                "type": hit["memory"]["memoryType"],
                "text": hit["memory"]["text"],
                "score": round(hit.get("score", 0.0), 4),
                "reasons": hit.get("reasons") or [],
            }
            for hit in hits
        ],
    )


@_guard
def build_context(args: dict, **_: Any) -> str:
    query = (args.get("query") or "").strip()
    if len(query) < 2:
        return _err("query must be at least 2 characters")
    result = _request(
        "/v1/memory/context",
        {
            "query": query,
            "filters": _filters(),
            "budget": {
                "maxItems": int(args.get("maxItems", 8)),
                "maxChars": int(args.get("maxChars", 3000)),
            },
        },
    )
    return _ok(
        context=result.get("contextText") or "",
        totalMemories=result.get("totalMemories", 0),
        ids=[item["id"] for item in result.get("selectedMemories") or []],
    )


@_guard
def feedback(args: dict, **_: Any) -> str:
    memory_id = args.get("memoryId")
    signal = _TYPE_MAP.get(args.get("signal") or "")
    if not memory_id or not signal:
        return _err("memoryId and signal (used|useful|not_useful) are required")
    result = _request("/v1/memory/feedback", {"memoryId": memory_id, "signal": signal})
    if not result.get("updated"):
        return _err("no active memory with id=%s" % memory_id)
    return _ok(recorded=args["signal"], memoryId=memory_id)


@_guard
def forget(args: dict, **_: Any) -> str:
    memory_id = args.get("memoryId")
    if not memory_id:
        return _err("memoryId is required")
    result = _request("/v1/memory/feedback", {"memoryId": memory_id, "signal": "negative"})
    if not result.get("updated"):
        return _err("no active memory with id=%s" % memory_id)
    return _ok(
        memoryId=memory_id,
        archived=False,
        note="Downranked. The memory-core REST API exposes no status endpoint, so "
        "the memory is suppressed in ranking but not archived.",
    )


@_guard
def supersede(args: dict, **_: Any) -> str:
    memory_id = args.get("memoryId")
    new_text = (args.get("newText") or "").strip()
    if not memory_id or len(new_text) < 4:
        return _err("memoryId and newText (min 4 chars) are required")
    observation = _observation(
        new_text,
        "fact",
        0.5,
        "actor",
        {"supersedes": memory_id, "supersedeReason": args.get("reason")},
    )
    ingested = _request("/v1/memory/ingest", {"observations": [observation]})
    _request("/v1/memory/feedback", {"memoryId": memory_id, "signal": "negative"})
    records = ingested.get("records") or [{}]
    return _ok(
        memoryId=memory_id,
        newId=records[0].get("id"),
        archived=False,
        note="Replacement stored and the old memory downranked. Remote memory-core "
        "cannot archive it, and the replacement is typed as `fact`.",
    )


HANDLERS = {
    "remember": remember,
    "recall": recall,
    "build_context": build_context,
    "forget": forget,
    "supersede": supersede,
    "feedback": feedback,
}
