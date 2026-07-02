import asyncio
import json
import os
from typing import Any


class TradingViewMcpError(RuntimeError):
    pass


def _server_command() -> list[str]:
    uvx = os.getenv("TRADINGVIEW_MCP_UVX", "/Users/sushanth/.local/bin/uvx")
    return [uvx, "--from", "tradingview-mcp-server", "tradingview-mcp", "stdio"]


async def _read_response(proc: asyncio.subprocess.Process, request_id: int, timeout: int) -> dict[str, Any]:
    if proc.stdout is None:
        raise TradingViewMcpError("TradingView MCP server did not open stdout.")

    while True:
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
        except TimeoutError as exc:
            raise TradingViewMcpError("TradingView MCP server timed out.") from exc

        if not line:
            stderr = ""
            if proc.stderr is not None:
                stderr = (await proc.stderr.read()).decode(errors="replace").strip()
            raise TradingViewMcpError(stderr or "TradingView MCP server stopped before responding.")

        response = json.loads(line)
        if response.get("id") == request_id:
            if "error" in response:
                message = response["error"].get("message", "TradingView MCP request failed.")
                raise TradingViewMcpError(message)
            return response


async def _send(proc: asyncio.subprocess.Process, payload: dict[str, Any]) -> None:
    if proc.stdin is None:
        raise TradingViewMcpError("TradingView MCP server did not open stdin.")
    proc.stdin.write((json.dumps(payload) + "\n").encode())
    await proc.stdin.drain()


async def analyze_symbol(symbol: str, exchange: str, timeframe: str) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *_server_command(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        await _send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "dhanam-krutva", "version": "0.1.0"},
                },
            },
        )
        init = await _read_response(proc, 1, timeout=30)
        await _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        await _send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "combined_analysis",
                    "arguments": {
                        "symbol": symbol.strip().upper(),
                        "exchange": exchange.strip().upper(),
                        "timeframe": timeframe,
                    },
                },
            },
        )
        response = await _read_response(proc, 2, timeout=90)
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except TimeoutError:
                proc.kill()
                await proc.wait()

    content = response.get("result", {}).get("content", [])
    text = next((item.get("text") for item in content if item.get("type") == "text"), None)
    if not text:
        raise TradingViewMcpError("TradingView MCP returned no analysis text.")

    try:
        analysis = json.loads(text)
    except json.JSONDecodeError:
        analysis = {"raw": text}

    return {
        "ok": True,
        "server": init.get("result", {}).get("serverInfo", {}),
        "tool": "combined_analysis",
        "analysis": analysis,
    }
