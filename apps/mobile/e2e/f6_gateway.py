"""Loopback native F6 acceptance: real gateway and JS host, simulated Core and Desktop opener."""
from pathlib import Path
import f5_gateway as f5
base = f5.base
base.CORE_FIXTURE = Path(__file__).with_name("f6_core.mjs")
base.CAPS += ["core_desktop_link"]
base.SESSION.update(title="Mobile F6")
app = base.app

@app.post("/__e2e/f6/{scenario}")
async def scenario(scenario: str):
    assert scenario in {"ready", "stale", "missing", "host_unavailable", "unavailable"}
    base.state.update(scenario=scenario, epoch=base.state["epoch"] + 1)
    return {"ok": True}

if __name__ == "__main__":
    base.uvicorn.run(app, host="127.0.0.1", port=8765)
