import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException

import polymarket
import predictfun

CONFIG_PATH = Path(__file__).resolve().parent / "market_links.json"


def load_config() -> list[dict[str, Any]]:
    return json.loads(CONFIG_PATH.read_text())


def get_outcome_price(market: dict[str, Any], outcome: str) -> str:
    if outcome == "yes":
        return str(market.get("yesPrice", "0"))

    return str(market.get("noPrice", "0"))


def get_outcome_token_id(market: dict[str, Any], outcome: str) -> str:
    if outcome == "yes":
        return str(market.get("yesTokenId", ""))

    return str(market.get("noTokenId", ""))


def find_market(markets: list[dict[str, Any]], market_id: str) -> dict[str, Any]:
    for market in markets:
        if str(market.get("id")) == market_id:
            return market

    raise HTTPException(status_code=404, detail=f"Market {market_id} not found")


async def build_polymarket_source(source: dict[str, Any]) -> dict[str, Any]:
    event = await polymarket.get_event(source["eventSlug"])
    market = find_market(event["markets"], source["marketId"])
    outcome = source["outcome"]

    return {
        "platform": "polymarket",
        "eventSlug": source["eventSlug"],
        "marketId": market["id"],
        "title": market["title"],
        "image": market.get("image", ""),
        "outcome": outcome,
        "price": get_outcome_price(market, outcome),
        "tokenId": get_outcome_token_id(market, outcome),
        "yesPrice": market.get("yesPrice", "0"),
        "noPrice": market.get("noPrice", "0"),
        "yesTokenId": market.get("yesTokenId", ""),
        "noTokenId": market.get("noTokenId", ""),
        "volume": market.get("volume", 0),
    }


def get_predictfun_title(market: dict[str, Any]) -> str:
    return str(
        market.get("title")
        or market.get("question")
        or market.get("name")
        or market.get("marketName")
        or ""
    )


def get_predictfun_price(market: dict[str, Any], outcome: str) -> str:
    for key in [f"{outcome}Price", f"{outcome}_price", "price", "probability"]:
        if key in market:
            return str(market[key])

    return "0"


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def best_price(sources: list[dict[str, Any]]) -> str:
    prices = [number(source.get("price")) for source in sources if number(source.get("price")) > 0]

    if not prices:
        return "0"

    return str(min(prices))


def opposite_price(price: str) -> str:
    value = number(price)

    if value <= 0:
        return "0"

    return str(max(0, 1 - value))


def first_token_id(sources: list[dict[str, Any]]) -> str:
    for source in sources:
        token_id = source.get("tokenId")
        if token_id:
            return str(token_id)

    return ""


def first_field(sources: list[dict[str, Any]], field: str) -> str:
    for source in sources:
        value = source.get(field)
        if value:
            return str(value)

    return ""


def total_volume(sources: list[dict[str, Any]]) -> float:
    return sum(number(source.get("volume")) for source in sources)


def get_polymarket_event_slug(event: dict[str, Any]) -> str:
    for linked_market in event["markets"]:
        for outcome in linked_market["outcomes"]:
            for source in outcome["sources"]:
                if source["platform"] == "polymarket":
                    return source["eventSlug"]

    raise HTTPException(status_code=404, detail="Polymarket event slug is missing")


def find_linked_outcome(event: dict[str, Any], market_id: str) -> dict[str, Any] | None:
    for linked_market in event["markets"]:
        for outcome in linked_market["outcomes"]:
            for source in outcome["sources"]:
                if source["platform"] == "polymarket" and source["marketId"] == market_id:
                    return outcome

    return None


def find_linked_market_by_outcome_id(event: dict[str, Any], outcome_id: str) -> dict[str, Any] | None:
    for linked_market in event["markets"]:
        for outcome in linked_market["outcomes"]:
            if outcome["id"] == outcome_id:
                return linked_market

    return None


def get_linked_polymarket_market_id(linked_market: dict[str, Any] | None) -> str:
    if not linked_market:
        return ""

    for linked_outcome in linked_market["outcomes"]:
        for source in linked_outcome["sources"]:
            if source["platform"] == "polymarket":
                return source["marketId"]

    return ""


async def build_predictfun_source(source: dict[str, Any]) -> dict[str, Any]:
    market = await predictfun.get_market(source["marketId"])
    outcome = source["outcome"]

    return {
        "platform": "predictfun",
        "marketId": source["marketId"],
        "title": get_predictfun_title(market),
        "outcome": outcome,
        "price": get_predictfun_price(market, outcome),
        "tokenId": source.get("tokenId", ""),
    }


async def build_source(source: dict[str, Any]) -> dict[str, Any]:
    if source["platform"] == "polymarket":
        return await build_polymarket_source(source)

    if source["platform"] == "predictfun":
        return await build_predictfun_source(source)

    raise HTTPException(status_code=404, detail=f"Unsupported platform: {source['platform']}")


async def get_combined_orderbook(
    event_id: str,
    market_id: str,
    outcome: str,
) -> dict[str, Any]:
    books = await get_orderbook_sources(event_id, market_id, outcome)

    return {
        "asks": merge_orders([order for book in books for order in book["asks"]]),
        "bids": merge_orders([order for book in books for order in book["bids"]]),
    }


async def get_orderbook_sources(
    event_id: str,
    market_id: str,
    outcome: str,
    platform: str = "combined",
) -> list[dict[str, Any]]:
    if platform not in ["combined", "polymarket", "predictfun"]:
        raise HTTPException(status_code=400, detail="platform must be combined, polymarket, or predictfun")

    event = next((item for item in load_config() if item["id"] == event_id), None)

    if not event:
        raise HTTPException(status_code=404, detail=f"Merged event {event_id} not found")

    polymarket_event = await polymarket.get_event(get_polymarket_event_slug(event))
    linked_market = find_linked_market_by_outcome_id(event, market_id)
    polymarket_market_id = get_linked_polymarket_market_id(linked_market) or market_id
    market = find_market(polymarket_event["markets"], polymarket_market_id)
    books = []

    token_id = get_outcome_token_id(market, outcome)
    if platform in ["combined", "polymarket"] and token_id:
        books.append({"platform": "polymarket", **polymarket.get_orderbook(token_id)})

    if platform in ["combined", "predictfun"] and linked_market:
        for linked_outcome in linked_market["outcomes"]:
            for source in linked_outcome["sources"]:
                if source["platform"] == "predictfun":
                    books.append({"platform": "predictfun", **await predictfun.get_orderbook(source["marketId"], outcome)})

    return books


def merge_orders(orders: list[dict[str, Any]]) -> list[dict[str, str]]:
    step = 0.001
    liquidity_by_price: dict[str, float] = {}

    for order in orders:
        price = round(number(order.get("price")) / step) * step
        size = number(order.get("size"))

        if not size:
            continue

        price_key = f"{price:.3f}"
        liquidity_by_price[price_key] = liquidity_by_price.get(price_key, 0) + size

    return [
        {"price": str(number(price)), "size": str(size)}
        for price, size in sorted(liquidity_by_price.items(), key=lambda item: number(item[0]))
    ]


async def quote_combined_orderbook(
    event_id: str,
    market_id: str,
    outcome: str,
    amount: float,
    platform: str = "combined",
) -> dict[str, Any]:
    if outcome not in ["yes", "no"]:
        raise HTTPException(status_code=400, detail="outcome must be yes or no")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be positive")

    books = await get_orderbook_sources(event_id, market_id, outcome, platform)
    asks_by_price_and_platform: dict[tuple[str, str], float] = {}
    for book in books:
        for order in book["asks"]:
            price = round(number(order.get("price")) / 0.001) * 0.001
            size = number(order.get("size"))

            if price <= 0 or size <= 0:
                continue

            key = (f"{price:.3f}", book["platform"])
            asks_by_price_and_platform[key] = asks_by_price_and_platform.get(key, 0) + size

    asks = [
        {"price": price, "platform": platform, "size": size}
        for (price, platform), size in asks_by_price_and_platform.items()
    ]
    asks.sort(key=lambda order: (number(order["price"]), -number(order["size"])))
    remaining = amount
    spent = 0.0
    shares = 0.0
    levels = []

    for order in asks:
        price = number(order["price"])
        available_shares = number(order["size"])

        if price <= 0 or available_shares <= 0 or remaining <= 0:
            continue

        shares_to_buy = min(available_shares, remaining / price)
        cost = shares_to_buy * price

        if shares_to_buy <= 0:
            continue

        spent += cost
        shares += shares_to_buy
        remaining -= cost
        levels.append({
            "platform": order["platform"],
            "price": str(price),
            "shares": shares_to_buy,
            "cost": cost,
        })

    return {
        "eventId": event_id,
        "marketId": market_id,
        "outcome": outcome,
        "amount": amount,
        "spent": spent,
        "unspent": max(0, remaining),
        "shares": shares,
        "avgPrice": spent / shares if shares else 0,
        "payoutIfWin": shares,
        "profitIfWin": shares - spent,
        "filled": remaining <= 0.000001,
        "levels": levels,
    }


async def get_merged_event(event_id: str) -> dict[str, Any]:
    events = load_config()
    event = next((item for item in events if item["id"] == event_id), None)

    if not event:
        raise HTTPException(status_code=404, detail=f"Merged event {event_id} not found")

    polymarket_event = await polymarket.get_event(get_polymarket_event_slug(event))
    markets = []

    for market in polymarket_event["markets"]:
        linked_outcome = find_linked_outcome(event, market["id"])

        if not linked_outcome:
            markets.append(market)
            continue

        sources = [await build_source(source) for source in linked_outcome["sources"]]
        yes_price = best_price(sources)

        markets.append({
            **market,
            "id": linked_outcome["id"],
            "question": linked_outcome["title"],
            "yesPrice": first_field(sources, "yesPrice") or yes_price,
            "noPrice": first_field(sources, "noPrice") or opposite_price(yes_price),
            "yesTokenId": first_field(sources, "yesTokenId") or first_token_id(sources),
            "noTokenId": first_field(sources, "noTokenId"),
            "volume": market.get("volume", 0),
            "sources": sources,
        })

    return {
        "id": polymarket_event["id"],
        "slug": event["id"],
        "title": event["title"],
        "image": polymarket_event.get("image", ""),
        "volume": polymarket_event.get("volume", 0),
        "markets": markets,
    }
