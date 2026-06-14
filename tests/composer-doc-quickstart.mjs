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
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

const apiKey = process.env.LIFI_API_KEY || process.env.VITE_LIFI_API_KEY
const signer = process.env.LIFI_FROM_ADDRESS
  || process.env.WALLET_ADDRESS
  || (process.env.PK ? privateKeyToAccount(`0x${process.env.PK.replace(/^0x/, '')}`).address : '')
const amount = process.env.COMPOSER_DOC_AMOUNT || '1000000'

if (!apiKey) throw new Error('Missing LIFI_API_KEY')
if (!signer) throw new Error('Missing signer address')

const sdk = createComposeSdk({
  baseUrl: process.env.COMPOSER_BASE_URL || process.env.VITE_COMPOSER_BASE_URL || 'https://ethglobal-composer.li.quest',
  apiKey,
})

const probe = sdk.flow(1, {
  name: 'proxy-probe',
  inputs: {
    amountIn: resources.erc20(USDC, 1),
  },
})

probe.core.transfer('transfer-usdc', {
  bind: { amount: probe.inputs.amountIn, recipient: probe.context.sender },
  config: {},
})


try {
  const probeResult = await probe.compile({
    signer,
    inputs: {
      amountIn: materialisers.directDeposit({ amount }),
    },
    checkOnChainAllowances: true,
    simulationPolicy: 'strict',
  })
  const quoteParams = new URLSearchParams({
    fromChain: '1',
    toChain: '1',
    fromToken: USDC,
    toToken: USDT,
    fromAmount: amount,
    fromAddress: probeResult.userProxy,
    toAddress: signer,
    slippage: '0.03',
    integrator: 'oddrouter',
  })
  const quoteResponse = await fetch(`https://li.quest/v1/quote?${quoteParams.toString()}`, {
    headers: { 'x-lifi-api-key': apiKey },
  })
  const quote = await quoteResponse.json()

  if (!quoteResponse.ok) throw new Error(JSON.stringify(quote))
  if (!quote.transactionRequest?.to || !quote.transactionRequest?.data) {
    throw new Error('Li.Fi quote did not return transaction data')
  }

  const builder = sdk.flow(1, {
    name: 'raw-lifi-diamond-call',
    inputs: {},
  })

  builder.core.rawCall('call-lifi-diamond', {
    bind: {},
    config: {
      target: quote.transactionRequest.to,
      calldata: quote.transactionRequest.data,
      callType: 'Call',
    },
  })

  const result = await builder.compile({
    signer,
    inputs: {},
    checkOnChainAllowances: true,
    simulationPolicy: 'strict',
  })

  if (!result.transactionRequest) throw new Error('Composer did not return transaction data')

  console.log(JSON.stringify({
    status: result.status,
    approvals: result.approvals?.length ?? 0,
    userProxy: result.userProxy,
    lifiTool: quote.tool,
    lifiTo: quote.transactionRequest.to,
    lifiSelector: quote.transactionRequest.data.slice(0, 10),
    producedResources: result.producedResources,
    simulationRevert: result.simulationRevert,
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
