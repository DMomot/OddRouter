import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

GAMMA_URL = "https://gamma-api.polymarket.com"
CLOB_URL = "https://clob.polymarket.com"
CLOB_CLIENT = ClobClient(CLOB_URL)
ROOT_DIR = Path(__file__).resolve().parents[1]

load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

POLYGON_RPC_URL = os.getenv("POLYGON_RPC_URL", "https://polygon.drpc.org")
PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
SPENDERS = {
    "ctfExchange": "0xE111180000d2663C0091e4f400237545B87B996B",
    "negRiskExchange": "0xe2222d279d744050d28e00520010520000310F59",
    "negRiskAdapter": "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
}


async def get_json(url: str) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, headers={"user-agent": "Mozilla/5.0"})

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


def clean_address(address: str) -> str:
    return address.lower().replace("0x", "").rjust(64, "0")


async def eth_call(rpc_url: str, to: str, data: str) -> str:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [{"to": to, "data": data}, "latest"],
            },
        )

    result = response.json()
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])

    return result.get("result", "0x0")


async def erc20_allowance(token: str, owner: str, spender: str) -> int:
    data = "0xdd62ed3e" + clean_address(owner) + clean_address(spender)
    return int(await eth_call(POLYGON_RPC_URL, token, data), 16)


async def erc1155_approved(token: str, owner: str, operator: str) -> bool:
    data = "0xe985e9c5" + clean_address(owner) + clean_address(operator)
    return int(await eth_call(POLYGON_RPC_URL, token, data), 16) == 1


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


def get_trading_client() -> ClobClient:
    private_key = os.getenv("POLYMARKET_PRIVATE_KEY")

    if not private_key:
        raise HTTPException(status_code=500, detail="POLYMARKET_PRIVATE_KEY is missing")

    client = ClobClient(
        CLOB_URL,
        chain_id=int(os.getenv("POLYMARKET_CHAIN_ID", "137")),
        key=private_key,
        signature_type=int(os.getenv("POLYMARKET_SIGNATURE_TYPE", "0")),
        funder=os.getenv("POLYMARKET_FUNDER"),
    )
    client.set_api_creds(client.create_or_derive_api_creds())
    return client


def place_fok_order(token_id: str, side: str, price: float, size: float) -> Any:
    if side not in ["buy", "sell"]:
        raise HTTPException(status_code=400, detail="side must be buy or sell")

    if price <= 0 or size <= 0:
        raise HTTPException(status_code=400, detail="price and size must be positive")

    client = get_trading_client()
    order = client.create_order(
        OrderArgs(
            token_id=token_id,
            price=price,
            size=size,
            side=BUY if side == "buy" else SELL,
        )
    )
    return client.post_order(order, OrderType.FOK)


async def check_approvals(wallet: str) -> dict[str, Any]:
    approvals = []

    for name, spender in SPENDERS.items():
        allowance = await erc20_allowance(PUSD, wallet, spender)
        approvals.append({
            "id": f"pusd-{name}",
            "type": "erc20",
            "token": PUSD,
            "spender": spender,
            "approved": allowance > 0,
            "allowance": str(allowance),
        })

        approved = await erc1155_approved(CONDITIONAL_TOKENS, wallet, spender)
        approvals.append({
            "id": f"conditional-tokens-{name}",
            "type": "erc1155",
            "token": CONDITIONAL_TOKENS,
            "spender": spender,
            "approved": approved,
        })

    return {
        "platform": "polymarket",
        "chainId": 137,
        "wallet": wallet,
        "approvals": approvals,
        "ready": all(item["approved"] for item in approvals),
    }
