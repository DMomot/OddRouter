import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  createComposeSdk,
  materialisers,
  resources,
} from '@lifi/composer-sdk'

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

function env(name, fallback = '') {
  return process.env[name] || fallback
}

loadEnv(path.join(rootDir, '.env'))
loadEnv(path.join(rootDir, 'backend', '.env'))

const signer = env('LIFI_FROM_ADDRESS') || env('WALLET_ADDRESS')
const apiKey = env('LIFI_API_KEY')

if (!signer) {
  console.error('Missing LIFI_FROM_ADDRESS or WALLET_ADDRESS')
  process.exit(1)
}

if (!apiKey) {
  console.error('Missing LIFI_API_KEY')
  process.exit(1)
}

const CHAIN_ID = Number(env('COMPOSER_CHAIN_ID', '1'))
const USDC = env('COMPOSER_FROM_TOKEN', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
const POLYGON_PUSD = env('COMPOSER_POLYGON_PUSD', '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB')
const BNB_USDT = env('COMPOSER_BNB_USDT', '0x55d398326f99059fF775485246999027B3197955')
const AMOUNT = env('COMPOSER_AMOUNT', '2000000')

const sdk = createComposeSdk({
  baseUrl: env('COMPOSER_BASE_URL', 'https://composer.li.quest'),
  apiKey,
})

const builder = sdk.flow(CHAIN_ID, {
  name: 'oddrouter-split-usdc',
  inputs: {
    amountIn: resources.erc20(USDC, CHAIN_ID),
  },
})

const { a, b } = builder.core.split('split', {
  bind: { source: builder.inputs.amountIn },
  config: { bps: 5000 },
})

builder.lifi.swap('swap-polygon-pusd', {
  bind: { amountIn: a },
  config: {
    resourceOut: resources.erc20(POLYGON_PUSD, 137),
    slippage: 0.03,
  },
})

builder.lifi.swap('swap-bnb-usdt', {
  bind: { amountIn: b },
  config: {
    resourceOut: resources.erc20(BNB_USDT, 56),
    slippage: 0.03,
  },
})

console.log('Compiling Li.Fi Composer flow...')
console.log(JSON.stringify({
  signer,
  chainId: CHAIN_ID,
  amount: AMOUNT,
  fromToken: USDC,
  outputs: [
    { chainId: 137, token: POLYGON_PUSD },
    { chainId: 56, token: BNB_USDT },
  ],
}, null, 2))

const result = await builder.compile({
  simulationPolicy: env('COMPOSER_SIMULATION_POLICY', 'strict'),
  signer,
  inputs: {
    amountIn: materialisers.directDeposit({ amount: AMOUNT }),
  },
  sweepTo: builder.context.sender,
})

console.log('\nComposer compile result:')
console.log(JSON.stringify({
  status: result.status,
  userProxy: result.userProxy,
  approvals: result.approvals,
  producedResources: result.producedResources,
  transactionRequest: result.transactionRequest ? {
    to: result.transactionRequest.to,
    value: result.transactionRequest.value,
    gasLimit: result.transactionRequest.gasLimit,
    hasData: Boolean(result.transactionRequest.data),
  } : null,
}, null, 2))
