export type AlchemyChainId = 1 | 56 | 137

export type Hex = `0x${string}`

export type AlchemyCall = {
  to: Hex
  data: Hex
  value: Hex
}

export type AlchemyApprovalItem = {
  type: string
  chainId?: number
  token: string
  spender: string
  approved: boolean
}

export type PrepareAlchemyCallsParams = {
  from: string
  chainId: AlchemyChainId
  calls: AlchemyCall[]
}

export type SendAlchemyPreparedCallsParams = {
  chainId: AlchemyChainId
  preparedCalls: unknown
}

export type AlchemyDebugLogger = (event: string, data?: unknown) => void

type WalletClientLike = {
  account?: unknown
  signMessage?: (params: { account?: unknown; message: { raw: Hex } }) => Promise<Hex>
  signAuthorization?: (params: {
    account?: unknown
    chainId: number
    contractAddress: Hex
    nonce: bigint
  }) => Promise<Hex | { r: Hex; s: Hex; yParity?: number | Hex; v?: bigint | number | Hex }>
}

type AuthorizationSignerLike = {
  signAuthorization?: (params: {
    address: Hex
    chainId: number
    nonce: bigint
  }) => Promise<Hex | { r: Hex; s: Hex; yParity?: number | Hex; v?: bigint | number | Hex }>
  signMessage?: (message: string) => Promise<Hex | string | undefined>
  signRawMessage?: (params: { accountAddress: string; message: string }) => Promise<Hex | string | undefined>
}

type PreparedItem = {
  type: string
  data: Record<string, unknown>
  chainId: Hex
  signatureRequest?: {
    type: string
    data?: { raw?: Hex } | Hex
    rawPayload?: Hex
  }
}

const alchemyApiKey = import.meta.env.VITE_ALCHEMY_API_KEY ?? ''

const alchemyPolicies: Record<AlchemyChainId, string> = {
  1: import.meta.env.VITE_ALCHEMY_GAS_POLICY_ID_ETHEREUM ?? '',
  56: import.meta.env.VITE_ALCHEMY_GAS_POLICY_ID_BNB ?? '',
  137: import.meta.env.VITE_ALCHEMY_GAS_POLICY_ID_POLYGON ?? '',
}

const alchemyPolicyEnvNames: Record<AlchemyChainId, string> = {
  1: 'VITE_ALCHEMY_GAS_POLICY_ID_ETHEREUM',
  56: 'VITE_ALCHEMY_GAS_POLICY_ID_BNB',
  137: 'VITE_ALCHEMY_GAS_POLICY_ID_POLYGON',
}

export function hasAlchemyConfig(chainId: AlchemyChainId) {
  return Boolean(alchemyApiKey && alchemyPolicies[chainId])
}

export function getAlchemyMissingConfig(chainId: AlchemyChainId) {
  const missing = []

  if (!alchemyApiKey) missing.push('VITE_ALCHEMY_API_KEY')
  if (!alchemyPolicies[chainId]) {
    missing.push(alchemyPolicyEnvNames[chainId])
  }

  return missing
}

export function buildAlchemyApprovalCalls(
  approvals: AlchemyApprovalItem[],
  chainId: AlchemyChainId,
  action: 'approve' | 'deapprove' = 'approve',
) {
  return approvals
    .filter((approval) => approval.chainId === chainId && approval.approved === (action === 'deapprove'))
    .map((approval) => {
      if (approval.type === 'erc20') {
        return {
          to: approval.token as Hex,
          data: `0x095ea7b3${encodeAddress(approval.spender)}${action === 'approve' ? encodeMaxUint256() : encodeUint256(0n)}` as Hex,
          value: '0x0' as Hex,
        }
      }

      if (approval.type === 'erc1155') {
        return {
          to: approval.token as Hex,
          data: `0xa22cb465${encodeAddress(approval.spender)}${encodeBool(action === 'approve')}` as Hex,
          value: '0x0' as Hex,
        }
      }

      return null
    })
    .filter((call): call is AlchemyCall => call !== null)
}

export async function prepareAlchemyCalls({ from, chainId, calls }: PrepareAlchemyCallsParams) {
  requireAlchemyConfig(chainId)

  return callAlchemyRpc<unknown>('wallet_prepareCalls', [
    {
      calls,
      from,
      chainId: toHex(chainId),
      capabilities: {
        paymasterService: {
          policyId: alchemyPolicies[chainId],
        },
      },
    },
  ])
}

export async function sendAlchemyPreparedCalls({ chainId, preparedCalls }: SendAlchemyPreparedCallsParams) {
  requireAlchemyConfig(chainId)

  return callAlchemyRpc<unknown>('wallet_sendPreparedCalls', [preparedCalls])
}

export async function signAlchemyPreparedCalls(
  preparedCalls: unknown,
  walletClient: WalletClientLike,
  fallbackAccount: string,
  authorizationSigner?: AuthorizationSignerLike,
  debug?: AlchemyDebugLogger,
) {
  if (isPreparedArray(preparedCalls)) {
    const signedItems = []

    for (const item of preparedCalls.data) {
      signedItems.push(await signPreparedItem(item, walletClient, fallbackAccount, authorizationSigner, debug))
    }

    return {
      ...preparedCalls,
      data: signedItems,
    }
  }

  if (isPreparedItem(preparedCalls)) {
    return signPreparedItem(preparedCalls, walletClient, fallbackAccount, authorizationSigner, debug)
  }

  throw new Error('Unknown Alchemy prepared calls format')
}

function isPreparedArray(value: unknown): value is { type: 'array'; data: PreparedItem[] } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: string }).type === 'array'
    && Array.isArray((value as { data?: unknown }).data),
  )
}

function isPreparedItem(value: unknown): value is PreparedItem {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { type?: unknown }).type === 'string'
    && typeof (value as { chainId?: unknown }).chainId === 'string',
  )
}

async function signPreparedItem(
  item: PreparedItem,
  walletClient: WalletClientLike,
  fallbackAccount: string,
  authorizationSigner?: AuthorizationSignerLike,
  debug?: AlchemyDebugLogger,
) {
  debug?.('alchemy:sign-item:start', {
    type: item.type,
    chainId: item.chainId,
    hasSignatureRequest: Boolean(item.signatureRequest),
    signatureRequestType: item.signatureRequest?.type,
    hasRawPayload: Boolean(item.signatureRequest?.rawPayload),
  })

  if (item.type === 'authorization' || item.type === 'eip-7702-authorization') {
    if (authorizationSigner?.signRawMessage && item.signatureRequest?.rawPayload) {
      debug?.('alchemy:sign-item:authorization-raw', {
        rawPayloadLength: item.signatureRequest.rawPayload.length,
      })
      const signature = await authorizationSigner.signRawMessage({
        accountAddress: fallbackAccount,
        message: item.signatureRequest.rawPayload.replace('0x', ''),
      })

      if (!signature) {
        throw new Error('Wallet does not support raw authorization signing')
      }

      return {
        ...item,
        signature: {
          type: 'secp256k1',
          data: signature as Hex,
        },
      }
    }

    const authorizationParams = {
      chainId: hexToNumber(item.chainId),
      address: item.data.address as Hex,
      nonce: BigInt(item.data.nonce as string),
    }

    const signedAuthorization = authorizationSigner?.signAuthorization
      ? await authorizationSigner.signAuthorization(authorizationParams)
      : await signAuthorizationWithWalletClient(walletClient, fallbackAccount, authorizationParams)
    debug?.('alchemy:sign-item:authorization-signed', {
      hasSignature: Boolean(signedAuthorization),
      signatureType: typeof signedAuthorization,
    })

    return {
      ...item,
      signature: normalizeSignature(signedAuthorization),
    }
  }

  const signature = authorizationSigner?.signRawMessage
    ? await authorizationSigner.signRawMessage({
      accountAddress: fallbackAccount,
      message: getSignatureRawPayload(item).replace('0x', ''),
    })
    : await signMessageWithWalletClient(walletClient, fallbackAccount, getSignatureRawMessage(item))
  debug?.('alchemy:sign-item:userop-signed', {
    hasSignature: Boolean(signature),
    signatureLength: signature?.length,
  })

  if (!signature) {
    throw new Error('Wallet does not support message signing')
  }

  return {
    ...item,
    signature: {
      type: 'secp256k1',
      data: signature as Hex,
    },
  }
}

async function signMessageWithWalletClient(walletClient: WalletClientLike, fallbackAccount: string, rawMessage: Hex) {
  if (!walletClient.signMessage) {
    throw new Error('Wallet does not support message signing')
  }

  return walletClient.signMessage({
    account: walletClient.account ?? fallbackAccount,
    message: { raw: rawMessage },
  })
}

async function signAuthorizationWithWalletClient(
  walletClient: WalletClientLike,
  fallbackAccount: string,
  params: { chainId: number; address: Hex; nonce: bigint },
) {
  if (!walletClient.signAuthorization) {
    throw new Error('Wallet does not support EIP-7702 authorization signing')
  }

  return walletClient.signAuthorization({
    account: walletClient.account ?? fallbackAccount,
    chainId: params.chainId,
    contractAddress: params.address,
    nonce: params.nonce,
  })
}

function getSignatureRawMessage(item: PreparedItem) {
  const data = item.signatureRequest?.data

  if (typeof data === 'object' && data?.raw) return data.raw
  if (typeof data === 'string') return data as Hex
  if (item.signatureRequest?.rawPayload) return item.signatureRequest.rawPayload

  throw new Error('Missing Alchemy signature request payload')
}

function getSignatureRawPayload(item: PreparedItem) {
  if (item.signatureRequest?.rawPayload) return item.signatureRequest.rawPayload

  return getSignatureRawMessage(item)
}

function normalizeSignature(signature: Hex | { r: Hex; s: Hex; yParity?: number | Hex; v?: bigint | number | Hex }) {
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

function requireAlchemyConfig(chainId: AlchemyChainId) {
  const missing = getAlchemyMissingConfig(chainId)

  if (missing.length > 0) {
    throw new Error(`Missing Alchemy config: ${missing.join(', ')}`)
  }
}

async function callAlchemyRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(`https://api.g.alchemy.com/v2/${alchemyApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  })

  const payload = (await response.json()) as { result?: T; error?: { message?: string } }

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? 'Alchemy request failed')
  }

  return payload.result as T
}

function toHex(value: number) {
  return `0x${value.toString(16)}` as Hex
}

function hexToNumber(value: Hex) {
  return Number.parseInt(value, 16)
}

function toHexValue(value: bigint | number | Hex) {
  if (typeof value === 'string') return value

  return `0x${value.toString(16)}` as Hex
}

function encodeAddress(value: string) {
  return value.toLowerCase().replace('0x', '').padStart(64, '0')
}

function encodeBool(value: boolean) {
  return value ? '1'.padStart(64, '0') : ''.padStart(64, '0')
}

function encodeMaxUint256() {
  return 'f'.repeat(64)
}

function encodeUint256(value: bigint) {
  return value.toString(16).padStart(64, '0')
}
