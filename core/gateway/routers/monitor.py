from typing import Any
from fastapi import APIRouter, Depends
from core.persistence import queries as db
from core.security.auth import cookie_auth_required

router = APIRouter()

@router.get("/api/monitor/usage")
async def get_monitor_usage(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Obtiene el resumen de uso general del usuario actual."""
    user_id = user_data["id"]
    return db.get_usage_summary(user_id)

@router.get("/api/monitor/usage/daily")
async def get_daily_usage(
    limit: int = 30,
    user_data: dict[str, Any] = Depends(cookie_auth_required)
):
    """Obtiene el registro diario detallado de tokens para graficar."""
    user_id = user_data["id"]
    metrics = db.get_daily_metrics(user_id, days_limit=limit)
    
    # Formateamos para que el frontend (Recharts) pueda consumirlo directamente
    # Agrupamos por fecha si hay múltiples modelos el mismo día
    by_date = {}
    for row in metrics:
        date_str = str(row["usage_date"])
        if date_str not in by_date:
            by_date[date_str] = {
                "date": date_str,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "latency_ms": 0,
                "requests": 0,
                "models": {}
            }
        
        by_date[date_str]["prompt_tokens"] += row["prompt_tokens"]
        by_date[date_str]["completion_tokens"] += row["completion_tokens"]
        by_date[date_str]["total_tokens"] += row["total_tokens"]
        by_date[date_str]["latency_ms"] += row["latency_sum_ms"]
        by_date[date_str]["requests"] += row["request_count"]
        
        model_name = row["model"]
        by_date[date_str]["models"][model_name] = row["total_tokens"]
        
    # Convertimos a lista ordenada cronológicamente
    chart_data = list(by_date.values())
    chart_data.sort(key=lambda x: x["date"])
    
    return chart_data
