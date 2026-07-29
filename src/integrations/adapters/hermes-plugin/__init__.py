"""memory-core plugin for Hermes Agent.

Install:  cp -r hermes-plugin ~/.hermes/plugins/memory-core
Enable:   hermes plugins enable memory-core

schemas.json is generated from src/integrations/tools.ts - regenerate with
`npm run integrations:schemas` rather than editing it by hand.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import tools

TOOLSET = "memory-core"
_SCHEMAS = json.loads((Path(__file__).parent / "schemas.json").read_text())


def register(ctx) -> None:
    """Wire the generated schemas to the HTTP-backed handlers."""
    for schema in _SCHEMAS:
        handler = tools.HANDLERS.get(schema["name"])
        if handler is None:
            continue
        ctx.register_tool(
            name=schema["name"],
            toolset=TOOLSET,
            schema=schema,
            handler=handler,
        )
