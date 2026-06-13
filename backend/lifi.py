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
CHAINS = {
    1: {
        "name": "ethereum",
        "rpcUrl": os.getenv("ETH_RPC_URL", "https://rpc.nodeflare.app/eth/public"),
    },
    56: {
        "name": "bsc",
        "rpcUrl": os.getenv("BNB_RPC_URL", "https://bsc.api.pocket.network"),
    },
    137: {
        "name": "polygon",
        "rpcUrl": os.getenv("POLYGON_RPC_URL", "https://polygon.drpc.org"),
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


async def erc20_allowance(rpc_url: str, token: str, owner: str, spender: str) -> int:
    data = "0xdd62ed3e" + clean_address(owner) + clean_address(spender)
    return int(await eth_call(rpc_url, token, data), 16)


async def check_approvals(
    wallet: str,
    tokens: str = "",
    spender: str = LIFI_ROUTER,
    min_amount: int = 0,
) -> dict[str, Any]:
    approvals = []

    for item in parse_tokens(tokens):
        chain_id = item["chainId"]
        token = item["token"]
        chain = CHAINS.get(chain_id)

        if not chain:
            raise HTTPException(status_code=400, detail=f"Unsupported Li.Fi chain: {chain_id}")

        if token.lower() == NATIVE_TOKEN:
            approvals.append({
                "id": f"lifi-{chain_id}-native",
                "chainId": chain_id,
                "chain": chain["name"],
                "type": "native",
                "token": token,
                "spender": spender,
                "approved": True,
                "allowance": "0",
            })
            continue

        allowance = await erc20_allowance(chain["rpcUrl"], token, wallet, spender)
        approvals.append({
            "id": f"lifi-{chain_id}-{token.lower()}",
            "chainId": chain_id,
            "chain": chain["name"],
            "type": "erc20",
            "token": token,
            "spender": spender,
            "approved": allowance > min_amount,
            "allowance": str(allowance),
        })

    return {
        "platform": "lifi",
        "wallet": wallet,
        "spender": spender,
        "approvals": approvals,
        "ready": bool(approvals) and all(item["approved"] for item in approvals),
    }
