import asyncio
import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

ROOT_DIR = Path(__file__).resolve().parents[1]

load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

LIFI_ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"
NATIVE_TOKEN = "0x0000000000000000000000000000000000000000"
ALCHEMY_API_KEY = os.getenv("ALCHEMY_API_KEY") or os.getenv("VITE_ALCHEMY_API_KEY")


def rpc_url(chain: str, fallback_env: str, fallback_url: str) -> str:
    if ALCHEMY_API_KEY:
        return f"https://{chain}.g.alchemy.com/v2/{ALCHEMY_API_KEY}"

    return os.getenv(fallback_env, fallback_url)


CHAINS = {
    1: {
        "name": "ethereum",
        "rpcUrl": rpc_url("eth-mainnet", "ETH_RPC_URL", "https://rpc.nodeflare.app/eth/public"),
    },
    56: {
        "name": "bsc",
        "rpcUrl": rpc_url("bnb-mainnet", "BNB_RPC_URL", "https://bsc.api.pocket.network"),
    },
    137: {
        "name": "polygon",
        "rpcUrl": rpc_url("polygon-mainnet", "POLYGON_RPC_URL", "https://polygon.drpc.org"),
    },
}


def clean_address(address: str) -> str:
    return address.lower().replace("0x", "").rjust(64, "0")


def parse_tokens(tokens: str) -> list[dict[str, Any]]:
    if not tokens:
        return []

    parsed = []
    for item in tokens.split(","):
        chain_id, token = item.split(":", 1)
        parsed.append({"chainId": int(chain_id), "token": token})

    return parsed


def parse_spenders(spender: str) -> dict[int, str]:
    if not spender:
        return {}

    parsed: dict[int, str] = {}
    for item in spender.split(","):
        if ":" not in item:
            continue

        chain_id, address = item.split(":", 1)
        parsed[int(chain_id)] = address

    return parsed


def spender_for_chain(spender: str, spender_by_chain: dict[int, str], chain_id: int) -> str:
    return spender_by_chain.get(chain_id, spender)


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


async def eth_call_batch(rpc_url: str, calls: list[tuple[str, str]]) -> list[str]:
    if not calls:
        return []

    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            rpc_url,
            json=[
                {
                    "jsonrpc": "2.0",
                    "id": index,
                    "method": "eth_call",
                    "params": [{"to": to, "data": data}, "latest"],
                }
                for index, (to, data) in enumerate(calls)
            ],
        )

    if response.status_code >= 400 or not response.text.strip():
        return [await eth_call(rpc_url, to, data) for to, data in calls]

    try:
        result = response.json()
    except ValueError:
        return [await eth_call(rpc_url, to, data) for to, data in calls]

    if isinstance(result, dict):
        if "error" in result:
            raise HTTPException(status_code=502, detail=result["error"])
        return [result.get("result", "0x0")]

    by_id = {item.get("id"): item for item in result}
    values = []
    for index in range(len(calls)):
        item = by_id.get(index, {})
        if "error" in item:
            raise HTTPException(status_code=502, detail=item["error"])
        values.append(item.get("result", "0x0"))

    return values


async def erc20_allowance(rpc_url: str, token: str, owner: str, spender: str) -> int:
    data = "0xdd62ed3e" + clean_address(owner) + clean_address(spender)
    return int(await eth_call(rpc_url, token, data), 16)


async def check_approvals(
    wallet: str,
    tokens: str = "",
    spender: str = LIFI_ROUTER,
    min_amount: int = 500_000_000,
) -> dict[str, Any]:
    slots = []
    groups: dict[str, list[tuple[int, str, str]]] = {}
    spender_by_chain = parse_spenders(spender)

    for item in parse_tokens(tokens):
        chain_id = item["chainId"]
        token = item["token"]
        chain = CHAINS.get(chain_id)
        chain_spender = spender_for_chain(spender, spender_by_chain, chain_id)

        if not chain:
            raise HTTPException(status_code=400, detail=f"Unsupported Li.Fi chain: {chain_id}")

        if token.lower() == NATIVE_TOKEN:
            slots.append({
                "id": f"lifi-{chain_id}-native",
                "chainId": chain_id,
                "chain": chain["name"],
                "type": "native",
                "token": token,
                "spender": chain_spender,
                "approved": True,
                "allowance": "0",
                "requiredAllowance": str(min_amount),
            })
            continue

        slots.append({
            "id": f"lifi-{chain_id}-{token.lower()}",
            "chainId": chain_id,
            "chain": chain["name"],
            "type": "erc20",
            "token": token,
            "spender": chain_spender,
            "approved": False,
            "allowance": "0",
            "requiredAllowance": str(min_amount),
        })
        data = "0xdd62ed3e" + clean_address(wallet) + clean_address(chain_spender)
        groups.setdefault(chain["rpcUrl"], []).append((len(slots) - 1, token, data))

    async def run_group(rpc_url: str, calls: list[tuple[int, str, str]]) -> list[tuple[int, str]]:
        results = await eth_call_batch(rpc_url, [(token, data) for _, token, data in calls])
        return [(slot_index, result) for (slot_index, _, _), result in zip(calls, results)]

    batches = await asyncio.gather(
        *(run_group(rpc_url, calls) for rpc_url, calls in groups.items())
    )
    for batch in batches:
        for slot_index, result in batch:
            allowance = int(result, 16)
            slots[slot_index]["approved"] = allowance >= min_amount
            slots[slot_index]["allowance"] = str(allowance)
            slots[slot_index]["requiredAllowance"] = str(min_amount)

    return {
        "platform": "lifi",
        "wallet": wallet,
        "spender": spender,
        "approvals": slots,
        "ready": bool(slots) and all(item["approved"] for item in slots),
    }
