from __future__ import annotations

from typing import Any, Awaitable, Callable, Tuple

import anyio
from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.session import ClientSession


ContextFactory = Callable[[], Awaitable[Any]] | Callable[[], Any]


class MCPClient:
    """Thin synchronous wrapper around an MCP stdio client."""

    def __init__(self, context_factory: ContextFactory) -> None:
        self._factory = context_factory

    def __enter__(self) -> "MCPClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return False

    def call_tool_sync(self, name: str, tool: str, args: dict[str, Any] | None) -> Any:
        async def _call() -> Any:
            context = self._factory()
            if hasattr(context, "__await__"):
                context_obj = await context  # type: ignore[func-returns-value]
            else:
                context_obj = context

            if isinstance(context_obj, StdioServerParameters):
                client = stdio_client(context_obj)
                resources = await client.__aenter__()  # type: ignore[func-returns-value]
                cleanup = client.__aexit__
            else:
                resources = await context_obj.__aenter__()  # type: ignore[attr-defined]
                cleanup = context_obj.__aexit__  # type: ignore[attr-defined]

            try:
                if not isinstance(resources, tuple) or len(resources) < 2:
                    raise RuntimeError("Unexpected resource payload from MCP context factory")
                read, write = resources[:2]
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    await session.list_tools()
                    result = await session.call_tool(tool, args or {})
                    return result
            finally:
                await cleanup(None, None, None)

        return anyio.run(_call)
