from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import polymarket
import predictfun
import lifi
import merged

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/approvals")
async def get_approvals(
    wallet: str,
    platform: str = "all",
    tokens: str = "",
    lifiSpender: str = lifi.LIFI_ROUTER,
    minAmount: int = 0,
) -> Any:
    if not wallet.startswith("0x") or len(wallet) != 42:
        raise HTTPException(status_code=400, detail="wallet must be an EVM address")

    if platform == "polymarket":
        return await polymarket.check_approvals(wallet)

    if platform == "predictfun":
        return await predictfun.check_approvals(wallet)

    if platform == "lifi":
        return await lifi.check_approvals(wallet, tokens, lifiSpender, minAmount)

    if platform == "all":
        platforms = [
            await polymarket.check_approvals(wallet),
            await predictfun.check_approvals(wallet),
            await lifi.check_approvals(wallet, tokens, lifiSpender, minAmount),
        ]

        return {
            "wallet": wallet,
            "ready": all(item["ready"] for item in platforms),
            "platforms": platforms,
        }

    unsupported_platform(platform)


def require_platform(platform: str, expected: str) -> None:
    if platform != expected:
        raise HTTPException(status_code=404, detail=f"Unsupported platform: {platform}")


def unsupported_platform(platform: str) -> None:
    raise HTTPException(status_code=404, detail=f"Unsupported platform: {platform}")


@app.get("/api/events/{event_slug}")
async def get_event(event_slug: str, platform: str = "polymarket") -> Any:
    require_platform(platform, "polymarket")
    return await polymarket.get_event(event_slug)


@app.get("/api/merged-events/{event_id}")
async def get_merged_event(event_id: str) -> Any:
    return await merged.get_merged_event(event_id)


@app.get("/api/combined-orderbook/quote")
async def get_combined_orderbook_quote(
    event_id: str,
    market_id: str,
    outcome: str,
    amount: float,
    platform: str = "combined",
) -> Any:
    return await merged.quote_combined_orderbook(event_id, market_id, outcome, amount, platform)


@app.get("/api/markets/{market_id}")
async def get_market(market_id: str, platform: str = "predictfun") -> Any:
    if platform == "predictfun":
        return await predictfun.get_market(market_id)

    unsupported_platform(platform)


@app.get("/api/orderbook/{token_id}")
async def get_orderbook(token_id: str, platform: str = "polymarket", outcome: str = "yes") -> Any:
    if platform == "polymarket":
        return polymarket.get_orderbook(token_id)

    if platform == "predictfun":
        return await predictfun.get_orderbook(token_id, outcome)

    unsupported_platform(platform)


@app.get("/api/categories/{slug}")
async def get_category(slug: str, platform: str = "predictfun") -> Any:
    if platform == "predictfun":
        return await predictfun.get_category(slug)

    unsupported_platform(platform)


@app.get("/api/predictfun/markets/{market_id}")
async def get_predict_market(market_id: str) -> Any:
    return await predictfun.get_market(market_id)


@app.get("/api/predictfun/markets/{market_id}/orderbook")
async def get_predict_orderbook(market_id: str, outcome: str = "yes") -> Any:
    return await predictfun.get_orderbook(market_id, outcome)


@app.get("/api/predictfun/categories/{slug}")
async def get_predict_category(slug: str) -> Any:
    return await predictfun.get_category(slug)
