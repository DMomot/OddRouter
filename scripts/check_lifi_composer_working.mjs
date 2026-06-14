import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk'

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

const apiKey = process.env.LIFI_API_KEY
const signer = process.env.LIFI_FROM_ADDRESS || process.env.WALLET_ADDRESS || '0x555EB6fE692D26f6E039C4841D1f36A4B7FC5170'

if (!apiKey) {
  console.error('Missing LIFI_API_KEY')
  process.exit(1)
}

const sdk = createComposeSdk({
  baseUrl: process.env.COMPOSER_BASE_URL || 'https://ethglobal-composer.li.quest',
  apiKey,
})

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const amount = process.env.COMPOSER_AMOUNT || '1000000'

const builder = sdk.flow(1, {
  name: 'working-usdc-to-usdt',
  inputs: {
    amountIn: resources.erc20(USDC, 1),
  },
})

builder.lifi.swap('swap-usdc-usdt', {
  bind: { amountIn: builder.inputs.amountIn },
  config: {
    resourceOut: resources.erc20(USDT, 1),
    slippage: 0.03,
  },
})

const result = await builder.compile({
  simulationPolicy: 'strict',
  signer,
  inputs: {
    amountIn: materialisers.directDeposit({ amount }),
  },
  sweepTo: signer,
})

console.log(JSON.stringify({
  status: result.status,
  approvals: result.approvals?.length ?? 0,
  hasTransaction: Boolean(result.transactionRequest),
  transactionRequest: result.transactionRequest ? {
    to: result.transactionRequest.to,
    value: result.transactionRequest.value,
    gasLimit: result.transactionRequest.gasLimit,
    hasData: Boolean(result.transactionRequest.data),
  } : null,
}, null, 2))
