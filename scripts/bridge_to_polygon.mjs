import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createClient, getQuote, getStatus } from '@lifi/sdk'
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, maxUint256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, polygon } from 'viem/chains'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

    const [key, ...valueParts] = trimmed.split('=')
    process.env[key] ||= valueParts.join('=').replace(/^["']|["']$/g, '')
  }
}

loadEnv(path.join(rootDir, '.env'))

const pk = process.env.PK?.startsWith('0x') ? process.env.PK : `0x${process.env.PK}`
const alchemyApiKey = process.env.VITE_ALCHEMY_API_KEY
const execute = process.env.EXECUTE === 'true'

if (!pk || pk === '0xundefined') throw new Error('Missing PK in .env')
if (!alchemyApiKey) throw new Error('Missing VITE_ALCHEMY_API_KEY in .env')

const account = privateKeyToAccount(pk)
const ethRpc = `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
const polygonRpc = `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
const ethClient = createPublicClient({ chain: mainnet, transport: http(ethRpc) })
const polygonClient = createPublicClient({ chain: polygon, transport: http(polygonRpc) })
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ethRpc) })
const lifi = createClient({ integrator: 'oddrouter' })

const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const amount = process.env.BRIDGE_AMOUNT ?? '2000000'

console.log('Wallet:', account.address)
console.log('Route: Ethereum USDC -> Polygon USDC')
console.log('Amount:', formatUnits(BigInt(amount), 6), 'USDC')
console.log('Mode:', execute ? 'EXECUTE' : 'DRY_RUN')

const quote = await getQuote(lifi, {
  fromChain: mainnet.id,
  toChain: polygon.id,
  fromToken: ETH_USDC,
  toToken: POLYGON_USDC,
  fromAmount: amount,
  fromAddress: account.address,
  toAddress: account.address,
  slippage: 0.01,
})

console.log('Tool:', quote.tool)
console.log('To amount:', formatUnits(BigInt(quote.estimate.toAmount), 6), 'USDC')
console.log('Approval spender:', quote.estimate.approvalAddress)
console.log('Bridge tx:', {
  to: quote.transactionRequest?.to,
  value: quote.transactionRequest?.value,
  gasLimit: quote.transactionRequest?.gasLimit,
  hasData: Boolean(quote.transactionRequest?.data),
})

if (!execute) {
  console.log('Dry-run only. Run with EXECUTE=true to send approval and bridge tx.')
  process.exit(0)
}

const allowance = await ethClient.readContract({
  address: ETH_USDC,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [account.address, quote.estimate.approvalAddress],
})

if (allowance < BigInt(amount)) {
  console.log('Approving USDC...')
  const approveHash = await walletClient.writeContract({
    address: ETH_USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [quote.estimate.approvalAddress, maxUint256],
  })
  console.log('Approve tx:', approveHash)
  await ethClient.waitForTransactionReceipt({ hash: approveHash })
}

if (!quote.transactionRequest?.to || !quote.transactionRequest.data) {
  throw new Error('Li.Fi quote missing transactionRequest')
}

const startBalance = await polygonClient.readContract({
  address: POLYGON_USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
})

console.log('Sending bridge tx...')
const bridgeHash = await walletClient.sendTransaction({
  account,
  chain: mainnet,
  to: quote.transactionRequest.to,
  data: quote.transactionRequest.data,
  value: BigInt(quote.transactionRequest.value ?? '0'),
  gas: quote.transactionRequest.gasLimit ? BigInt(quote.transactionRequest.gasLimit) : undefined,
})
console.log('Bridge tx:', bridgeHash)
await ethClient.waitForTransactionReceipt({ hash: bridgeHash })

for (let attempt = 1; attempt <= 120; attempt += 1) {
  const status = await getStatus(lifi, {
    txHash: bridgeHash,
    bridge: quote.tool,
    fromChain: String(mainnet.id),
    toChain: String(polygon.id),
  }).catch((error) => ({ status: 'UNKNOWN', error: error.message }))

  console.log('Status:', status.status)
  if (status.status === 'DONE') break
  if (status.status === 'FAILED') throw new Error(`Bridge failed: ${JSON.stringify(status)}`)

  const balance = await polygonClient.readContract({
    address: POLYGON_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (balance > startBalance) {
    console.log('Polygon balance updated:', formatUnits(balance, 6), 'USDC')
    break
  }

  await new Promise((resolve) => setTimeout(resolve, 5_000))
}
