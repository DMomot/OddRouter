import os
from pathlib import Path
from dataclasses import asdict, is_dataclass
from decimal import Decimal
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


def auth_headers() -> dict[str, str]:
    jwt = os.getenv("PREDICTFUN_JWT") or os.getenv("PREDICTFUN_AUTH_TOKEN")

    if not jwt:
        raise HTTPException(status_code=500, detail="PREDICTFUN_JWT is missing in backend/.env")

    return {**headers(), "Authorization": f"Bearer {jwt}"}


async def get_json(path: str) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{BASE_URL}{path}", headers=headers())

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


async def post_json(path: str, body: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(f"{BASE_URL}{path}", headers=auth_headers(), json=body)

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


async def get_market(market_id: str) -> Any:
    return await get_json(f"/v1/markets/{market_id}")


def to_wei(value: float) -> int:
    return int(Decimal(str(value)) * Decimal("1000000000000000000"))


def serialize(value: Any) -> Any:
    if is_dataclass(value):
        return {key: serialize(item) for key, item in asdict(value).items()}

    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}

    if isinstance(value, list):
        return [serialize(item) for item in value]

    if hasattr(value, "model_dump"):
        return serialize(value.model_dump())

    if hasattr(value, "__dict__") and not isinstance(value, (str, int, float, bool)):
        return {
            key: serialize(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }

    return value


def get_market_data(market: Any) -> dict[str, Any]:
    data = market.get("data", market) if isinstance(market, dict) else {}
    return data if isinstance(data, dict) else {}


def get_outcome_token_id(market: dict[str, Any], outcome: str) -> str:
    for item in market.get("outcomes", []):
        if str(item.get("name", "")).lower() == outcome:
            return str(item.get("onChainId", ""))

    return ""


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


async def place_fok_order(
    market_id: str,
    token_id: str | None,
    outcome: str,
    side: str,
    price: float,
    size: float,
    fee_rate_bps: int | None = None,
    is_neg_risk: bool | None = None,
    is_yield_bearing: bool | None = None,
) -> Any:
    if side not in ["buy", "sell"]:
        raise HTTPException(status_code=400, detail="side must be buy or sell")

    if price <= 0 or size <= 0:
        raise HTTPException(status_code=400, detail="price and size must be positive")

    private_key = os.getenv("PREDICTFUN_PRIVATE_KEY")
    predict_account = os.getenv("PREDICTFUN_ACCOUNT")

    if not private_key:
        raise HTTPException(status_code=500, detail="PREDICTFUN_PRIVATE_KEY is missing in backend/.env")

    try:
        from predict_sdk import (
            BuildOrderInput,
            ChainId,
            LimitHelperInput,
            OrderBuilder,
            OrderBuilderOptions,
            Side,
        )
    except ImportError as error:
        raise HTTPException(status_code=500, detail="predict-sdk is missing") from error

    market = get_market_data(await get_market(market_id))
    resolved_token_id = token_id or get_outcome_token_id(market, outcome)

    if not resolved_token_id:
        raise HTTPException(status_code=400, detail="tokenId is missing")

    builder_options = OrderBuilderOptions(predict_account=predict_account) if predict_account else None
    builder = OrderBuilder.make(ChainId.BNB_MAINNET, private_key, builder_options)
    sdk_side = Side.BUY if side == "buy" else Side.SELL
    amounts = builder.get_limit_order_amounts(
        LimitHelperInput(
            side=sdk_side,
            price_per_share_wei=to_wei(price),
            quantity_wei=to_wei(size),
        )
    )
    order = builder.build_order(
        "LIMIT",
        BuildOrderInput(
            side=sdk_side,
            token_id=resolved_token_id,
            maker_amount=str(amounts.maker_amount),
            taker_amount=str(amounts.taker_amount),
            fee_rate_bps=fee_rate_bps if fee_rate_bps is not None else int(market.get("feeRateBps", 0)),
        ),
    )
    typed_data = builder.build_typed_data(
        order,
        is_neg_risk=is_neg_risk if is_neg_risk is not None else bool(market.get("isNegRisk")),
        is_yield_bearing=(
            is_yield_bearing if is_yield_bearing is not None else bool(market.get("isYieldBearing"))
        ),
    )
    signed_order = builder.sign_typed_data_order(typed_data)
    order_hash = builder.build_typed_data_hash(typed_data)

    return await post_json(
        "/v1/orders",
        {
            "data": {
                "order": {**serialize(signed_order), "hash": order_hash},
                "pricePerShare": str(amounts.price_per_share),
                "strategy": "LIMIT",
                "isFillOrKill": True,
            }
        },
    )
