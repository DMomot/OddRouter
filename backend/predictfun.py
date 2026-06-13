import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = "https://api.predict.fun"

load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)


def headers() -> dict[str, str]:
    api_key = (
        os.getenv("PREDICTFUN_API_KEY")
        or os.getenv("predictfun_key")
        or os.getenv("PREDICTFUN_KEY")
    )

    if not api_key:
        raise HTTPException(status_code=500, detail="PREDICTFUN_API_KEY is missing in backend/.env")

    return {"x-api-key": api_key}


async def get_json(path: str) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{BASE_URL}{path}", headers=headers())

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


async def get_market(market_id: str) -> Any:
    return await get_json(f"/v1/markets/{market_id}")


def normalize_order(order: Any) -> dict[str, str]:
    if isinstance(order, list):
        return {"price": str(order[0]), "size": str(order[1])}

    if isinstance(order, dict):
        return {"price": str(order.get("price", "0")), "size": str(order.get("size", "0"))}

    return {"price": "0", "size": "0"}


def normalize_orderbook(data: Any) -> dict[str, Any]:
    book = data.get("data", data) if isinstance(data, dict) else {}
    asks = [normalize_order(order) for order in book.get("asks", [])]
    bids = [normalize_order(order) for order in book.get("bids", [])]

    asks.sort(key=lambda order: float(order["price"]), reverse=True)
    bids.sort(key=lambda order: float(order["price"]), reverse=True)

    return {"asks": asks, "bids": bids}


def invert_orderbook(book: dict[str, Any]) -> dict[str, Any]:
    asks = [
        {"price": str(1 - float(order["price"])), "size": order["size"]}
        for order in book["bids"]
    ]
    bids = [
        {"price": str(1 - float(order["price"])), "size": order["size"]}
        for order in book["asks"]
    ]

    asks.sort(key=lambda order: float(order["price"]), reverse=True)
    bids.sort(key=lambda order: float(order["price"]), reverse=True)

    return {"asks": asks, "bids": bids}


async def get_orderbook(market_id: str, outcome: str = "yes") -> Any:
    data = await get_json(f"/v1/markets/{market_id}/orderbook")
    book = normalize_orderbook(data)

    if outcome == "no":
        return invert_orderbook(book)

    return book


async def get_category(slug: str) -> Any:
    return await get_json(f"/v1/categories/{slug}")
