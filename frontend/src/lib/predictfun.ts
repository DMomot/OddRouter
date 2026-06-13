import { ChainId, OrderBuilder, Side } from '@predictdotfun/sdk'
import { parseEther } from 'ethers'

export const predictBuilder = OrderBuilder.make(ChainId.BnbMainnet)

export function getPredictLimitBuyAmounts(price: string, shares: string) {
  return predictBuilder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: parseEther(price),
    quantityWei: parseEther(shares),
  })
}

export { ChainId, Side }
