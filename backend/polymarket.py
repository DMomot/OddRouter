from typing import Any

import httpx
from fastapi import HTTPException
from py_clob_client.client import ClobClient

GAMMA_URL = "https://gamma-api.polymarket.com"
CLOB_URL = "https://clob.polymarket.com"
CLOB_CLIENT = ClobClient(CLOB_URL)


async def get_json(url: str) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, headers={"user-agent": "Mozilla/5.0"})

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


def parse_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value

    if not isinstance(value, str):
        return []

    try:
        import json

        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_order(order: Any) -> dict[str, str]:
    if isinstance(order, dict):
        return {"price": str(order.get("price", "0")), "size": str(order.get("size", "0"))}

    return {"price": str(getattr(order, "price", "0")), "size": str(getattr(order, "size", "0"))}


def normalize_market(market: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    prices = parse_list(market.get("outcomePrices"))
    token_ids = parse_list(market.get("clobTokenIds"))

    return {
        "id": str(market.get("id", "")),
        "title": market.get("groupItemTitle") or market.get("question") or "",
        "question": market.get("question") or "",
        "image": market.get("image") or market.get("icon") or event.get("image") or "",
        "yesPrice": str(prices[0]) if len(prices) > 0 else "0",
        "noPrice": str(prices[1]) if len(prices) > 1 else "0",
        "yesTokenId": str(token_ids[0]) if len(token_ids) > 0 else "",
        "noTokenId": str(token_ids[1]) if len(token_ids) > 1 else "",
        "volume": market.get("volumeNum") or number(market.get("volume")),
    }


def normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    markets = [normalize_market(market, event) for market in event.get("markets", [])]
    markets.sort(key=lambda market: number(market["yesPrice"]), reverse=True)

    return {
        "platform": "polymarket",
        "id": str(event.get("id", "")),
        "slug": event.get("slug") or "",
        "title": (event.get("title") or "").strip(),
        "image": event.get("image") or event.get("icon") or "",
        "volume": event.get("volume") or 0,
        "markets": markets,
    }


def normalize_orderbook(book: Any) -> dict[str, Any]:
    data = book.model_dump() if hasattr(book, "model_dump") else book
    asks_raw = data.get("asks", []) if isinstance(data, dict) else getattr(data, "asks", [])
    bids_raw = data.get("bids", []) if isinstance(data, dict) else getattr(data, "bids", [])

    asks = [normalize_order(order) for order in asks_raw]
    bids = [normalize_order(order) for order in bids_raw]
    asks.sort(key=lambda order: number(order["price"]), reverse=True)
    bids.sort(key=lambda order: number(order["price"]), reverse=True)

    return {
        "market": data.get("market") if isinstance(data, dict) else getattr(data, "market", None),
        "asset_id": data.get("asset_id") if isinstance(data, dict) else getattr(data, "asset_id", None),
        "asks": asks,
        "bids": bids,
    }


async def get_event(event_slug: str) -> dict[str, Any]:
    event = await get_json(f"{GAMMA_URL}/events/slug/{event_slug}")
    return normalize_event(event)


def get_orderbook(token_id: str) -> dict[str, Any]:
    book = CLOB_CLIENT.get_order_book(token_id)
    return normalize_orderbook(book)
