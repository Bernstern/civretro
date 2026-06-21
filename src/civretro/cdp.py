"""
Coherent Gameface CDP client — queries Civ 7's V8 runtime via Chrome DevTools Protocol.

Endpoint: ws://<host>:9444/devtools/page/0
No auth, no handshake beyond WebSocket upgrade.
Works in both SP and MP (confirmed); does not require EnableTuner.
"""

import asyncio
import json
import websockets

from civretro.log import get_logger

log = get_logger(__name__)

CDP_HOST = "172.17.0.1"  # WSL2: Windows host = default gateway
CDP_PORT = 9444
CDP_PAGE = "devtools/page/0"


class CDPClient:
    def __init__(self, host=CDP_HOST, port=CDP_PORT):
        self.uri = f"ws://{host}:{port}/{CDP_PAGE}"
        self._ws = None
        self._msg_id = 0

    @property
    def connected(self):
        if self._ws is None:
            return False
        # websockets >= 12 uses close_code; earlier used .closed
        try:
            return self._ws.close_code is None
        except AttributeError:
            return not self._ws.closed

    async def connect(self):
        log.debug("connecting to %s", self.uri)
        self._ws = await websockets.connect(self.uri, open_timeout=5)
        log.debug("connected to %s", self.uri)

    async def close(self):
        if self._ws:
            log.debug("closing CDP connection")
            await self._ws.close()
            self._ws = None

    async def evaluate(self, js: str, timeout: float = 5.0) -> str:
        self._msg_id += 1
        msg = json.dumps({
            "id": self._msg_id,
            "method": "Runtime.evaluate",
            "params": {"expression": js, "returnByValue": True},
        })
        log.debug("CDP eval id=%d", self._msg_id)
        await self._ws.send(msg)
        raw = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
        resp = json.loads(raw)
        result = resp.get("result", {}).get("result", {})
        if result.get("type") == "string":
            return result["value"]
        raise RuntimeError(f"Unexpected CDP result: {resp}")


async def eval_any(c: CDPClient, js: str, timeout: float = 20.0):
    """Evaluate JS and return a Python value for any primitive result type."""
    c._msg_id += 1
    msg = json.dumps({
        "id": c._msg_id,
        "method": "Runtime.evaluate",
        "params": {"expression": js, "returnByValue": True},
    })
    await c._ws.send(msg)
    raw = await asyncio.wait_for(c._ws.recv(), timeout=timeout)
    resp = json.loads(raw)
    result = resp.get("result", {}).get("result", {})
    t = result.get("type")
    if t in ("string", "boolean", "number"):
        return result["value"]
    if t == "undefined":
        return None
    return result
