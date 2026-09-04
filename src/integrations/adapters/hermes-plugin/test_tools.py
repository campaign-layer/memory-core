"""Contract tests for the dependency-free Hermes HTTP adapter."""

from __future__ import annotations

import json
import io
import os
import urllib.error
import unittest
from unittest.mock import patch

import tools


IDENTITY_ENV = {
    "MEMORY_CORE_URL": "http://memory.test",
    "MEMORY_TENANT_ID": "acme",
    "MEMORY_APP_ID": "hermes",
    "MEMORY_ACTOR_ID": "alice",
}


class _Response:
    def __init__(self, payload=None):
        self.payload = payload or {"created": 1, "updated": 0, "records": [{"id": "mem_1"}]}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class HermesToolsTest(unittest.TestCase):
    def test_invalid_type_is_rejected_before_http(self):
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request, "urlopen"
        ) as urlopen:
            result = json.loads(tools.remember({"text": "Valid durable text", "type": "secret"}))
        self.assertIn("type must be one of", result["error"])
        urlopen.assert_not_called()

    def test_shared_and_thread_scopes_require_explicit_context(self):
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request, "urlopen"
        ) as urlopen:
            workspace = json.loads(
                tools.remember({"text": "Valid workspace memory", "scope": "workspace"})
            )
            thread = json.loads(tools.remember({"text": "Valid thread memory", "scope": "thread"}))
        self.assertEqual(workspace["error"], "workspace scope requires MEMORY_SPACE_ID")
        self.assertEqual(thread["error"], "thread scope requires MEMORY_THREAD_ID")
        urlopen.assert_not_called()

    def test_valid_write_is_identity_pinned_and_bounded(self):
        with patch.dict(
            os.environ,
            {**IDENTITY_ENV, "MEMORY_SPACE_ID": "team", "MEMORY_THREAD_ID": "thread-1"},
            clear=True,
        ), patch.object(tools.urllib.request, "urlopen", return_value=_Response()) as urlopen:
            result = json.loads(
                tools.remember(
                    {
                        "text": "Alice prefers compact release notes",
                        "type": "preference",
                        "importance": 0.8,
                        "scope": "workspace",
                    }
                )
            )
        self.assertEqual(result, {"stored": True, "id": "mem_1", "created": 1, "merged": 0})
        request = urlopen.call_args.args[0]
        body = json.loads(request.data)
        observation = body["observations"][0]
        self.assertEqual(
            {key: observation[key] for key in ("tenantId", "spaceId", "appId", "actorId")},
            {"tenantId": "acme", "spaceId": "team", "appId": "hermes", "actorId": "alice"},
        )

    def test_supersede_uses_atomic_endpoint(self):
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request,
            "urlopen",
            return_value=_Response({
                "updated": True,
                "atomic": True,
                "created": True,
                "replacement": {"id": "new_1"},
            }),
        ) as urlopen:
            result = json.loads(tools.supersede({
                "memoryId": "old_1",
                "newText": "Current generated summary",
            }))

        self.assertEqual(result["newId"], "new_1")
        self.assertTrue(result["atomic"])
        self.assertEqual(urlopen.call_count, 1)
        request = urlopen.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/v1/memory/supersede"))
        body = json.loads(request.data)
        self.assertEqual(body["memoryId"], "old_1")
        self.assertEqual(body["source"]["sourceType"], "hermes-agent")

    def test_supersede_falls_back_on_missing_route_and_preserves_server_fields(self):
        missing = urllib.error.HTTPError(
            "http://memory.test/v1/memory/supersede",
            404,
            "not found",
            None,
            io.BytesIO(b"not found"),
        )
        responses = [
            missing,
            _Response({"memory": {
                "id": "old_1",
                "text": "Old generated summary",
                "memoryType": "summary",
                "importance": 0.6,
                "scope": "app",
            }}),
            _Response({"created": 1, "updated": 0, "records": [{"id": "new_1"}]}),
            _Response({"updated": True}),
        ]
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request, "urlopen", side_effect=responses
        ) as urlopen:
            result = json.loads(tools.supersede({
                "memoryId": "old_1",
                "newText": "Current generated summary",
            }))

        self.assertEqual(result["newId"], "new_1")
        self.assertFalse(result["atomic"])
        ingest_request = urlopen.call_args_list[2].args[0]
        observation = json.loads(ingest_request.data)["observations"][0]
        self.assertEqual(observation["memoryType"], "summary")
        self.assertEqual(observation["scope"], "app")

    def test_supersede_does_not_downgrade_server_failures(self):
        unavailable = urllib.error.HTTPError(
            "http://memory.test/v1/memory/supersede",
            500,
            "server error",
            None,
            io.BytesIO(b"internal"),
        )
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request, "urlopen", side_effect=unavailable
        ) as urlopen:
            result = json.loads(tools.supersede({
                "memoryId": "old_1",
                "newText": "Current generated summary",
            }))

        self.assertIn("HTTP 500", result["error"])
        self.assertEqual(urlopen.call_count, 1)

    def test_supersede_reports_structured_partial_provider_failure(self):
        with patch.dict(os.environ, IDENTITY_ENV, clear=True), patch.object(
            tools.urllib.request,
            "urlopen",
            return_value=_Response({
                "updated": False,
                "atomic": False,
                "partial": True,
                "failure": "provider_error",
                "replacement": {"id": "new_1"},
            }),
        ):
            result = json.loads(tools.supersede({
                "memoryId": "old_1",
                "newText": "Current generated summary",
            }))

        self.assertIn("provider failed during retirement", result["error"])
        self.assertEqual(result["newId"], "new_1")
        self.assertFalse(result["atomic"])
        self.assertTrue(result["partial"])
        self.assertFalse(result["archived"])


if __name__ == "__main__":
    unittest.main()
