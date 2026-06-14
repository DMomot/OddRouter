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
const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'

const apiKey = process.env.LIFI_API_KEY || process.env.VITE_LIFI_API_KEY
const privateKey = process.env.PK ? `0x${process.env.PK.replace(/^0x/, '')}` : ''
const testAccount = privateKey ? privateKeyToAccount(privateKey) : null
const signer = process.env.COMPOSER_TEST_SIGNER
  || process.env.LIFI_FROM_ADDRESS
  || process.env.WALLET_ADDRESS
  || testAccount?.address
const amount = process.env.COMPOSER_DOC_AMOUNT || '10000000'

if (!apiKey) throw new Error('Missing LIFI_API_KEY')
if (!signer) throw new Error('Missing signer address')

const sdk = createComposeSdk({
  baseUrl: process.env.COMPOSER_BASE_URL || process.env.VITE_COMPOSER_BASE_URL || 'https://ethglobal-composer.li.quest',
  apiKey,
})

const alchemyApiKey = process.env.VITE_ALCHEMY_API_KEY || process.env.ALCHEMY_API_KEY
const alchemyGasPolicyId = process.env.VITE_ALCHEMY_GAS_POLICY_ID_ETHEREUM
  || process.env.ALCHEMY_GAS_POLICY_ID_ETHEREUM

function cleanAddress(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

async function ethCall(to, data) {
  if (!alchemyApiKey) return null

  const response = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  const result = await response.json()
  if (result.error) throw new Error(JSON.stringify(result.error))
  return BigInt(result.result)
}

async function erc20BalanceOf(owner) {
  return ethCall(USDC, `0x70a08231${cleanAddress(owner)}`)
}

async function erc20Allowance(owner, spender) {
  return ethCall(USDC, `0xdd62ed3e${cleanAddress(owner)}${cleanAddress(spender)}`)
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, '0')
}

function buildApproveTransaction(spender, value) {
  return {
    to: USDC,
    data: `0x095ea7b3${cleanAddress(spender)}${encodeUint256(value)}`,
    value: '0x0',
  }
}

function usdcLog(value) {
  if (value === null) return null
  return {
    raw: value.toString(),
    usdc: Number(value) / 1e6,
  }
}

function toHexValue(value) {
  if (typeof value === 'string') return value
  return `0x${value.toString(16)}`
}

function normalizeSignature(signature) {
  if (typeof signature === 'string') {
    return {
      type: 'secp256k1',
      data: signature,
    }
  }

  return {
    type: 'secp256k1',
    data: {
      ...signature,
      yParity: signature.yParity === undefined ? undefined : toHexValue(signature.yParity),
      v: signature.v === undefined ? undefined : toHexValue(signature.v),
    },
  }
}

function stringifyRpcPayload(value) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ))
}

async function readDebugState({ wallet, proxy, diamond }) {
  const [
    walletBalance,
    proxyBalance,
    walletToProxy,
    proxyToDiamond,
  ] = await Promise.all([
    erc20BalanceOf(wallet),
    erc20BalanceOf(proxy),
    erc20Allowance(wallet, proxy),
    erc20Allowance(proxy, diamond),
  ])

  return {
    wallet,
    proxy,
    diamond,
    balances: {
      wallet: usdcLog(walletBalance),
      proxy: usdcLog(proxyBalance),
    },
    allowances: {
      walletToProxy: usdcLog(walletToProxy),
      proxyToDiamond: usdcLog(proxyToDiamond),
    },
  }
}

async function readExtendedDebugState({ wallet, proxy, diamond, composerTxTo }) {
  const state = await readDebugState({ wallet, proxy, diamond })
  return {
    ...state,
    composerTxTo,
    allowances: {
      ...state.allowances,
      walletToComposerTxTo: composerTxTo ? usdcLog(await erc20Allowance(wallet, composerTxTo)) : null,
    },
  }
}

async function callAlchemyRpc(method, params) {
  if (!alchemyApiKey || !alchemyGasPolicyId) {
    throw new Error('Missing Alchemy config for sponsored approval')
  }

  const response = await fetch(`https://api.g.alchemy.com/v2/${alchemyApiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stringifyRpcPayload({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  })
  const payload = await response.json()
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Alchemy request failed')
  return payload.result
}

async function signPreparedItem(item) {
  if (!testAccount) throw new Error('Missing PK for signing sponsored approval')

  if (item.type === 'authorization' || item.type === 'eip-7702-authorization') {
    if (!testAccount.signAuthorization) throw new Error('PK signer does not support EIP-7702 authorization')

    const signature = await testAccount.signAuthorization({
      chainId: Number.parseInt(item.chainId, 16),
      contractAddress: item.data.address,
      nonce: BigInt(item.data.nonce),
    })

    return {
      ...item,
      signature: normalizeSignature(signature),
    }
  }

  const rawMessage = typeof item.signatureRequest?.data === 'string'
    ? item.signatureRequest.data
    : item.signatureRequest?.data?.raw || item.signatureRequest?.rawPayload
  if (!rawMessage) throw new Error('Missing Alchemy signature payload')

  const signature = await testAccount.signMessage({ message: { raw: rawMessage } })
  return {
    ...item,
    signature: {
      type: 'secp256k1',
      data: signature,
    },
  }
}

async function signPreparedCalls(preparedCalls) {
  if (preparedCalls?.type === 'array' && Array.isArray(preparedCalls.data)) {
    return {
      ...preparedCalls,
      data: await Promise.all(preparedCalls.data.map(signPreparedItem)),
    }
  }

  if (preparedCalls?.type) return signPreparedItem(preparedCalls)
  throw new Error('Unknown Alchemy prepared calls format')
}

async function sendSponsoredApproval(transactionRequest) {
  if (!testAccount) throw new Error('Missing PK for sponsored approval')
  if (testAccount.address.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`PK address ${testAccount.address} does not match signer ${signer}`)
  }

  const prepared = await callAlchemyRpc('wallet_prepareCalls', [{
    from: signer,
    chainId: '0x1',
    calls: [{
      to: transactionRequest.to,
      data: transactionRequest.data,
      value: transactionRequest.value ? `0x${BigInt(transactionRequest.value).toString(16)}` : '0x0',
    }],
    capabilities: {
      paymasterService: {
        policyId: alchemyGasPolicyId,
      },
    },
  }])
  const signed = await signPreparedCalls(prepared)
  return callAlchemyRpc('wallet_sendPreparedCalls', [signed])
}

async function waitForAllowanceAtLeast(owner, spender, minimum) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const allowance = await erc20Allowance(owner, spender)
    if (allowance !== null && allowance >= BigInt(minimum)) return allowance
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  throw new Error(`Allowance did not update for ${owner} -> ${spender}`)
}

try {
  const probe = sdk.flow(1, {
    name: 'proxy-probe',
    inputs: {
      amountIn: resources.erc20(USDC, 1),
    },
  })

  probe.core.transfer('return-usdc', {
    bind: {
      amount: probe.inputs.amountIn,
      recipient: probe.context.sender,
    },
    config: {},
  })

  const probeResult = await probe.compile({
    signer,
    inputs: {
      amountIn: materialisers.directDeposit({ amount }),
    },
    checkOnChainAllowances: true,
    simulationPolicy: 'strict',
  })

  if (!probeResult.userProxy) throw new Error('Composer did not return user proxy')

  const routesResponse = await fetch('https://li.quest/v1/advanced/routes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lifi-api-key': apiKey,
    },
    body: JSON.stringify({
      fromChainId: 1,
      toChainId: 56,
      fromTokenAddress: USDC,
      toTokenAddress: BNB_USDT,
      fromAmount: amount,
      fromAddress: probeResult.userProxy,
      toAddress: signer,
      options: {
        slippage: 0.03,
        integrator: 'oddrouter',
        order: 'CHEAPEST',
        allowSwitchChain: false,
        allowDestinationCall: false,
        executionType: 'transaction',
      },
    }),
  })
  const routes = await routesResponse.json()

  if (!routesResponse.ok) throw new Error(JSON.stringify(routes))

  const candidates = await Promise.all((routes.routes ?? []).slice(0, 5).map(async (route) => {
    const step = route.steps?.[0]
    if (!step) return null

    const stepResponse = await fetch('https://li.quest/v1/advanced/stepTransaction', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lifi-api-key': apiKey,
      },
      body: JSON.stringify(step),
    })
    const stepQuote = await stepResponse.json()
    if (!stepResponse.ok || !stepQuote.transactionRequest?.to || !stepQuote.transactionRequest?.data) return null

    return {
      route,
      step,
      transactionRequest: stepQuote.transactionRequest,
    }
  }))

  const quote = candidates
    .filter(Boolean)
    .filter((candidate) => BigInt(candidate.transactionRequest.value ?? '0') === 0n)
    .filter((candidate) => candidate.transactionRequest.to.toLowerCase() === LIFI_DIAMOND.toLowerCase())
    .sort((a, b) => Number(BigInt(b.route.toAmount ?? '0') - BigInt(a.route.toAmount ?? '0')))[0]

  if (!quote) {
    throw new Error(JSON.stringify({
      message: 'Li.Fi did not return a zero-value Diamond route',
      checkedRoutes: candidates.filter(Boolean).map((candidate) => ({
        tool: candidate.step.tool,
        toAmount: candidate.route.toAmount,
        txTo: candidate.transactionRequest?.to,
        value: candidate.transactionRequest?.value,
        selector: candidate.transactionRequest?.data?.slice(0, 10),
      })),
    }))
  }

  const quoteParams = {
    fromChain: '1',
    toChain: '56',
    fromToken: USDC,
    toToken: BNB_USDT,
    fromAmount: amount,
    fromAddress: probeResult.userProxy,
    toAddress: signer,
    routeId: quote.route.id,
    tool: quote.step.tool,
  }

  console.log('debug:on-chain-before-compile', JSON.stringify(await readDebugState({
    wallet: signer,
    proxy: probeResult.userProxy,
    diamond: quote.transactionRequest.to,
  }), null, 2))
  console.log('debug:lifi-route', JSON.stringify({
    ...quoteParams,
    transactionTo: quote.transactionRequest.to,
    transactionValue: quote.transactionRequest.value ?? '0',
    selector: quote.transactionRequest.data.slice(0, 10),
  }, null, 2))

  const builder = sdk.flow(1, {
    name: 'transfer-approve-rawcall-lifi-diamond',
    inputs: {
      amountIn: resources.erc20(USDC, 1),
      proxyRecipient: 'address',
      diamondSpender: 'address',
    },
  })

  // builder.core.call('transfer-from-wallet-to-proxy', {
  //   resource: builder.inputs.amountIn,
  //   bind: {
  //     from: builder.context.sender,
  //     to: builder.inputs.proxyRecipient,
  //     value: builder.inputs.amountIn,
  //   },
  //   config: {
  //     target: USDC,
  //     functionSignature: 'function transferFrom(address from, address to, uint256 value)',
  //   },
  // })
  // const proxyTransfer = builder.core.transfer('transfer-usdc-to-proxy', {
  //   bind: {
  //     amount: builder.inputs.amountIn,
  //     recipient: builder.inputs.proxyRecipient,
  //   },
  //   config: {},
  // })
  console.log('debug:composer-transfer', JSON.stringify({
    step: 'transfer-proxy-balance-to-proxy',
    from: 'read-proxy-usdc-balance-after-approve.balance',
    to: 'builder.inputs.proxyRecipient',
    amount: 'read-proxy-usdc-balance-after-approve.balance',
    note: 'Built-in Composer transfer, not manual ERC20 transferFrom.',
  }, null, 2))

  // const proxyBalance = builder.core.balanceOf('read-proxy-usdc-after-transfer', {
  //   bind: {},
  //   config: {
  //     token: USDC,
  //     owner: probeResult.userProxy,
  //   },
  // })
  // builder.core.transfer('return-transfer-remainder', {
  //   bind: {
  //     amount: proxyTransfer.remainder,
  //     recipient: builder.context.sender,
  //   },
  //   config: {},
  // })

  // builder.core.balanceOf('read-execution-usdc-balance', {
  //   bind: {},
  //   config: {
  //     token: USDC,
  //     owner: probeResult.userProxy,
  //   },
  // })

  // builder.core.transfer('return-usdc-after-allowance-check', {
  //   bind: {
  //     amount: proxyTransfer.transferred,
  //     recipient: builder.context.sender,
  //   },
  //   config: {},
  // })

  builder.core.call('approve-lifi-diamond', {
    resource: builder.inputs.amountIn,
    bind: {
      spender: builder.inputs.diamondSpender,
      value: builder.inputs.amountIn,
    },
    config: {
      target: USDC,
      functionSignature: 'function approve(address spender, uint256 value)',
    },
  })

  const proxyBalanceAfterApprove = builder.core.balanceOf('read-proxy-usdc-balance-after-approve', {
    bind: {},
    config: {
      token: USDC,
      owner: probeResult.userProxy,
    },
  })

  builder.core.transfer('transfer-proxy-balance-to-proxy', {
    bind: {
      amount: proxyBalanceAfterApprove.balance,
      recipient: builder.inputs.proxyRecipient,
    },
    config: { amount: '1' },
  })

  // builder.core.staticCall('read-proxy-diamond-allowance', {
  //   bind: {
  //     owner: builder.inputs.proxyRecipient,
  //     spender: builder.inputs.diamondSpender,
  //   },
  //   config: {
  //     target: USDC,
  //     functionSignature: 'function allowance(address owner, address spender) view returns (uint256)',
  //   },
  // })

  // builder.invariant.allowanceAtLeast('check-proxy-diamond-allowance', {
  //   bind: {
  //     minimumAmount: builder.inputs.amountIn,
  //     owner: builder.inputs.proxyRecipient,
  //     spender: builder.inputs.diamondSpender,
  //   },
  // })

  builder.core.rawCall('bridge-to-bnb', {
    bind: {},
    config: {
      target: quote.transactionRequest.to,
      calldata: quote.transactionRequest.data,
      callType: 'Call',
    },
  })

  let result = await builder.compile({
    signer,
    inputs: {
      amountIn: materialisers.directDeposit({ amount }),
      proxyRecipient: probeResult.userProxy,
      diamondSpender: quote.transactionRequest.to,
    },
    checkOnChainAllowances: true,
    simulationPolicy: process.env.COMPOSER_SIMULATION_POLICY || 'strict',
    // sweepTo: builder.context.sender,
  })

  console.log('debug:compile-only-approvals', JSON.stringify(result.approvals?.map((approval) => ({
    token: approval.token,
    spender: approval.spender,
    amount: approval.amount,
    txTo: approval.transactionRequest?.to,
    txSelector: approval.transactionRequest?.data?.slice(0, 10),
  })) ?? [], null, 2))

  // Compile-only test: do not send approvals or transactions here.
  // if ((result.approvals?.length ?? 0) > 0) {
  //   for (const approval of result.approvals) {
  //     if (!approval.transactionRequest) continue
  //     const sent = await sendSponsoredApproval(approval.transactionRequest)
  //     console.log('debug:approval-sent', JSON.stringify(sent, null, 2))
  //     await waitForAllowanceAtLeast(signer, approval.spender, approval.amount)
  //   }
  //
  //   result = await builder.compile({
  //     signer,
  //     inputs: {
  //       amountIn: materialisers.directDeposit({ amount }),
  //       proxyRecipient: probeResult.userProxy,
  //       diamondSpender: quote.transactionRequest.to,
  //     },
  //     checkOnChainAllowances: true,
  //     simulationPolicy: process.env.COMPOSER_SIMULATION_POLICY || 'strict',
  //     sweepTo: builder.context.sender,
  //   })
  // }

  console.log('debug:on-chain-after-compile', JSON.stringify(await readDebugState({
    wallet: signer,
    proxy: probeResult.userProxy,
    diamond: quote.transactionRequest.to,
  }), null, 2))

  if (!result.transactionRequest) throw new Error('Composer did not return transaction data')
  console.log('COMPILE_OK')

  console.log(JSON.stringify({
    status: result.status,
    approvals: result.approvals?.length ?? 0,
    approvalDetails: result.approvals?.map((approval) => ({
      token: approval.token,
      spender: approval.spender,
      amount: approval.amount,
      txTo: approval.transactionRequest?.to,
      txSelector: approval.transactionRequest?.data?.slice(0, 10),
    })),
    quoteFromAddress: probeResult.userProxy,
    userProxy: result.userProxy,
    lifiTool: quote.step.tool,
    lifiTo: quote.transactionRequest.to,
    lifiSelector: quote.transactionRequest.data.slice(0, 10),
    producedHandles: result.producedHandles,
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
