"""Loopback-only F5 native acceptance: production gateway/host, simulated Core RPC.

Core durability/security is covered separately by Rust integration tests. Never
connects to a real database, account or provider. See MOBILE_F5.md for limits.
"""
from pathlib import Path
import f4_gateway as base

base.CORE_FIXTURE = Path(__file__).with_name("f5_core.mjs")
base.CAPS += ["mobile_question", "mobile_launch_approval", "mobile_review", "mobile_controls"]
base.SESSION.update(title="Mobile F5")
base.remote.authenticate = lambda *args: {**base.USER, "session_id": 1, "client": "mobile"}
base.state.update(epoch=0, effects=[])
app = base.app


@app.post("/__e2e/f5/{scenario}")
async def scenario(scenario: str):
    assert scenario in {"ready", "elevated", "expired", "stale", "large", "head_moved", "unsupported", "stop_failure", "stop_timeout", "queue_failure", "lost_ack"}
    base.state.update(scenario=scenario, epoch=base.state["epoch"] + 1)
    return {"ok": True}


if __name__ == "__main__":
    base.uvicorn.run(app, host="127.0.0.1", port=8765)
