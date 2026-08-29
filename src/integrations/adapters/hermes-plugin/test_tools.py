"""Contract tests for the dependency-free Hermes HTTP adapter."""

from __future__ import annotations

import json
import os
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

    def test_supersede_preserves_server_derived_type_and_scope(self):
        responses = [
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
        ingest_request = urlopen.call_args_list[1].args[0]
        observation = json.loads(ingest_request.data)["observations"][0]
        self.assertEqual(observation["memoryType"], "summary")
        self.assertEqual(observation["scope"], "app")


if __name__ == "__main__":
    unittest.main()
