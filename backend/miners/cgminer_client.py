# SPDX-License-Identifier: AGPL-3.0-only
"""Async cgminer client.

Both Canaan Avalon (Nano 3s, A10, Q) and Braiins BMM/BOSminer speak a
variant of the cgminer-API protocol on port 4028.

It's a "request/response over a short TCP connection" protocol:
1. open the socket
2. write the command as JSON ``{"command": "summary"}`` or as a plain
   string ``summary``
3. read until EOF (the server closes the connection)
4. parse

Responses come in two dialects:
- "modern" cgminer → JSON
- legacy avalon / cgminer 4.x → pipe-delimited text like
  ``STATUS=S,When=...|SUMMARY,Elapsed=123,...|``

This module provides :class:`CgminerClient` with methods that handle
both forms and return Python dicts.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any


class CgminerError(Exception):
    """Communication/parsing error."""


class CgminerClient:
    def __init__(self, host: str, port: int = 4028, timeout: float = 4.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    async def _send(self, payload: bytes) -> bytes:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=self.timeout,
            )
        except (OSError, asyncio.TimeoutError) as exc:
            raise CgminerError(f"connect {self.host}:{self.port} failed: {exc}") from exc

        try:
            writer.write(payload)
            await writer.drain()
            try:
                data = await asyncio.wait_for(reader.read(-1), timeout=self.timeout)
            except asyncio.TimeoutError as exc:
                raise CgminerError(f"timeout reading from {self.host}") from exc
            return data
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    async def call(self, command: str, parameter: str | None = None) -> dict[str, Any]:
        """Execute a command and return a dict.

        Try the JSON form first (modern cgminer/Braiins). If the
        response isn't JSON-parseable, fall back to the pipe-delimited
        parser.
        """
        # JSON form: {"command":"summary"} or {"command":"ascset","parameter":"0,led,1-1"}
        if parameter:
            req = json.dumps({"command": command, "parameter": parameter})
        else:
            req = json.dumps({"command": command})
        raw = await self._send(req.encode("ascii"))
        text = _decode(raw)
        return _parse_response(text)

    async def call_text(self, command: str) -> dict[str, Any]:
        """Plain-text form of the command (some versions require it)."""
        raw = await self._send(command.encode("ascii"))
        text = _decode(raw)
        return _parse_response(text)


def _decode(raw: bytes) -> str:
    """Decode, stripping NUL terminators (typical of cgminer)."""
    if not raw:
        return ""
    text = raw.decode("utf-8", errors="replace")
    return text.rstrip("\x00\r\n ")


def _parse_response(text: str) -> dict[str, Any]:
    """Try JSON, then cgminer pipe-format, then a single key=val block."""
    if not text:
        raise CgminerError("empty response")

    # 1) JSON?
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except (ValueError, TypeError):
        pass

    # 2) Pipe format ``STATUS=...|SECTION,k=v,k=v|SECTION2,...|``
    parts = [p for p in text.split("|") if p.strip()]
    if not parts:
        raise CgminerError(f"unparseable: {text[:80]!r}")

    out: dict[str, Any] = {"_raw_text": text}
    for part in parts:
        section_dict = _parse_kv_section(part)
        if not section_dict:
            continue
        # Use the first pair as the "type" (e.g. SUMMARY, STATS, VERSION).
        section_name = section_dict.get("_section") or "MISC"
        existing = out.get(section_name)
        if existing is None:
            out[section_name] = section_dict
        elif isinstance(existing, list):
            existing.append(section_dict)
        else:
            out[section_name] = [existing, section_dict]
    return out


def _parse_kv_section(part: str) -> dict[str, Any]:
    """Parse a ``NAME,k1=v1,k2=v2`` block.

    Avalon often ships ``MM ID0=Ver[...] Tmax[74] Fan1[3671] ...``:
    fields inside square brackets are captured as a sub-key.
    """
    section: dict[str, Any] = {}
    items = [s.strip() for s in part.split(",") if s.strip()]
    if not items:
        return section
    first = items[0]
    if "=" not in first:
        section["_section"] = first
        items = items[1:]
    for item in items:
        if "=" not in item:
            continue
        key, _, value = item.partition("=")
        key = key.strip()
        value = value.strip()
        # if the value contains ``Foo[...] Bar[...]`` blocks, expand them
        if "[" in value and value.endswith("]") and " " in value:
            sub = _parse_bracketed(value)
            if sub:
                section.setdefault("_groups", {}).setdefault(key, sub)
                continue
        section[key] = _coerce(value)
    return section


def _parse_bracketed(text: str) -> dict[str, str]:
    """Parse strings like ``Tavg[65] Fan1[3671] Fan2[3635]``."""
    out: dict[str, str] = {}
    token = ""
    depth = 0
    for ch in text + " ":
        if ch == "[":
            depth += 1
            token += ch
        elif ch == "]":
            depth -= 1
            token += ch
        elif ch == " " and depth == 0:
            if token:
                if "[" in token and token.endswith("]"):
                    name, _, val = token.partition("[")
                    out[name.strip()] = val[:-1].strip()
                token = ""
        else:
            token += ch
    return out


def _coerce(value: str) -> Any:
    if value == "":
        return value
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value
