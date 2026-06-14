import fs from 'node:fs'
import path from 'node:path'
import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk'
import { privateKeyToAccount } from 'viem/accounts'

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

    const [key, ...valueParts] = trimmed.split('=')
    process.env[key] ||= valueParts.join('=').replace(/^["']|["']$/g, '')
  }
}

loadEnv(path.resolve('.env'))

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const POLYGON_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'

const apiKey = process.env.LIFI_API_KEY || process.env.VITE_LIFI_API_KEY
const signer = process.env.LIFI_FROM_ADDRESS
  || process.env.WALLET_ADDRESS
  || (process.env.PK ? privateKeyToAccount(`0x${process.env.PK.replace(/^0x/, '')}`).address : '')

if (!apiKey) throw new Error('Missing LIFI_API_KEY')
if (!signer) throw new Error('Missing signer address')

const sdk = createComposeSdk({
  baseUrl: process.env.COMPOSER_BASE_URL || process.env.VITE_COMPOSER_BASE_URL || 'https://ethglobal-composer.li.quest',
  apiKey,
})

const builder = sdk.flow(1, {
  name: 'bridge-usdc-to-polygon-pusd',
  inputs: {
    amountIn: resources.erc20(USDC, 1),
  },
})

builder.lifi.swap('bridge', {
  bind: { amountIn: builder.inputs.amountIn },
  config: {
    resourceOut: resources.erc20(POLYGON_PUSD, 137),
    slippage: 0.03,
  },
})

console.log(JSON.stringify(builder.build(), null, 2))

try {
  const result = await builder.compile({
    signer,
    inputs: {
      amountIn: materialisers.directDeposit({
        amount: process.env.COMPOSER_DOC_AMOUNT || '1000000',
      }),
    },
    sweepTo: builder.context.sender,
  })

  console.log(JSON.stringify({
    status: result.status,
    approvals: result.approvals?.length ?? 0,
    userProxy: result.userProxy,
    producedResources: result.producedResources,
    transactionRequest: result.transactionRequest ? {
      to: result.transactionRequest.to,
      value: result.transactionRequest.value,
      gasLimit: result.transactionRequest.gasLimit,
      hasData: Boolean(result.transactionRequest.data),
    } : null,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    message: error.message,
    name: error.name,
    status: error.status,
    code: error.code,
    kind: error.kind,
    details: error.details,
  }, null, 2))
  process.exitCode = 1
}
