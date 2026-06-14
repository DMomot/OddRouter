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

for (const line of fs.readFileSync(path.join(rootDir, '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) process.env[line.slice(0, i)] ||= line.slice(i + 1)
}

const pk = process.env.PK?.startsWith('0x') ? process.env.PK : `0x${process.env.PK}`
const key = process.env.VITE_ALCHEMY_API_KEY
if (!pk || pk === '0xundefined') throw new Error('Missing PK')
if (!key) throw new Error('Missing VITE_ALCHEMY_API_KEY')

const account = privateKeyToAccount(pk)
const recipient = '0x555EB6fE692D26f6E039C4841D1f36A4B7FC5170'
const lifi = createClient({ integrator: 'oddrouter' })

const clients = {
  1: {
    public: createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`) }),
    wallet: createWalletClient({ account, chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`) }),
    chain: mainnet,
  },
  137: {
    public: createPublicClient({ chain: polygon, transport: http(`https://polygon-mainnet.g.alchemy.com/v2/${key}`) }),
    wallet: createWalletClient({ account, chain: polygon, transport: http(`https://polygon-mainnet.g.alchemy.com/v2/${key}`) }),
    chain: polygon,
  },
}

const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'

async function executeBridge(name, params) {
  console.log(`\n${name}`)
  const quote = await getQuote(lifi, params)
  const source = clients[params.fromChain]

  console.log('Tool:', quote.tool)
  console.log('Expected out:', quote.estimate.toAmount)
  console.log('Approval spender:', quote.estimate.approvalAddress)

  const allowance = await source.public.readContract({
    address: params.fromToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, quote.estimate.approvalAddress],
  })

  if (allowance < BigInt(params.fromAmount)) {
    const approveHash = await source.wallet.writeContract({
      address: params.fromToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [quote.estimate.approvalAddress, maxUint256],
    })
    console.log('Approve tx:', approveHash)
    await source.public.waitForTransactionReceipt({ hash: approveHash })
  }

  const tx = quote.transactionRequest
  if (!tx?.to || !tx.data) throw new Error('Missing transactionRequest')

  const hash = await source.wallet.sendTransaction({
    account,
    chain: source.chain,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? '0'),
    gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  })
  console.log('Bridge tx:', hash)
  await source.public.waitForTransactionReceipt({ hash })

  for (let i = 0; i < 120; i += 1) {
    const status = await getStatus(lifi, {
      txHash: hash,
      bridge: quote.tool,
      fromChain: String(params.fromChain),
      toChain: String(params.toChain),
    }).catch(() => undefined)
    if (status?.status) console.log('Status:', status.status)
    if (status?.status === 'DONE') return hash
    if (status?.status === 'FAILED') throw new Error(`${name} failed`)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }

  return hash
}

console.log('Sender:', account.address)
console.log('Recipient:', recipient)

await executeBridge('Reverse: Polygon USDC -> Ethereum USDC', {
  fromChain: 137,
  toChain: 1,
  fromToken: POLYGON_USDC,
  toToken: ETH_USDC,
  fromAmount: '1000000',
  fromAddress: account.address,
  toAddress: account.address,
  slippage: 0.01,
})

await executeBridge('Bridge+swap: Ethereum USDC -> Polygon pUSD', {
  fromChain: 1,
  toChain: 137,
  fromToken: ETH_USDC,
  toToken: PUSD,
  fromAmount: '1000000',
  fromAddress: account.address,
  toAddress: recipient,
  slippage: 0.01,
})

const pusdBalance = await clients[137].public.readContract({
  address: PUSD,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [recipient],
})
console.log('Recipient pUSD:', formatUnits(pusdBalance, 6))
