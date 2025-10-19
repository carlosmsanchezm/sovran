from __future__ import annotations

import json
from typing import Any

from mcp import types

_original_model_validate_json = types.JSONRPCMessage.model_validate_json.__func__


@classmethod
def _compat_model_validate_json(
    cls,
    json_data: str | bytes | bytearray,
    *,
    strict: bool | None = None,
    extra: Any | None = None,
    context: Any | None = None,
    by_alias: bool | None = None,
    by_name: bool | None = None,
) -> types.JSONRPCMessage:
    try:
        return _original_model_validate_json(
            cls,
            json_data,
            strict=strict,
            extra=extra,
            context=context,
            by_alias=by_alias,
            by_name=by_name,
        )
    except Exception:
        if isinstance(json_data, (bytes, bytearray)):
            try:
                normalized = json_data.decode("utf-8")
            except Exception:
                raise
        else:
            normalized = json_data

        try:
            payload = json.loads(normalized)
        except Exception:
            raise

        if isinstance(payload, dict) and payload.get("method") == "initialize":
            payload.setdefault("jsonrpc", "2.0")

            params = payload.get("params")
            if not isinstance(params, dict):
                params = {}
                payload["params"] = params

            capabilities = params.get("capabilities")
            if not isinstance(capabilities, dict):
                capabilities = {}
                params["capabilities"] = capabilities

            capabilities.setdefault("experimental", {})

            return _original_model_validate_json(
                cls,
                json.dumps(payload),
                strict=strict,
                extra=extra,
                context=context,
                by_alias=by_alias,
                by_name=by_name,
            )

        raise


types.JSONRPCMessage.model_validate_json = classmethod(_compat_model_validate_json)
