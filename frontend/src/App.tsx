import { useEffect, useRef, useState } from 'react'
import { DynamicWidget, useDynamicContext, useOpenFundingOptions, useUserWallets } from '@dynamic-labs/sdk-react-core'
import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk'
import {
  type AlchemyCall,
  type AlchemyChainId,
  buildAlchemyApprovalCalls,
  prepareAlchemyCalls,
  sendAlchemyPreparedCalls,
  signAlchemyPreparedCalls,
} from './alchemy'
import eventSlugs from './eventIds.json'
import './App.css'

const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const alchemyApiKey = import.meta.env.VITE_ALCHEMY_API_KEY ?? ''
const lifiComposerApiKey = import.meta.env.VITE_LIFI_API_KEY ?? import.meta.env.LIFI_API_KEY ?? ''
const lifiComposerBaseUrl = import.meta.env.VITE_COMPOSER_BASE_URL ?? 'https://ethglobal-composer.li.quest'
const lifiApprovalTokens = [
  '1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  '56:0x55d398326f99059fF775485246999027B3197955',
  '137:0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
].join(',')
const lifiApprovalMinAmount = '500000000'
const usdcBalanceTokens = [
  { chainId: 1, rpc: 'eth-mainnet', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainId: 56, rpc: 'bnb-mainnet', token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  { chainId: 137, rpc: 'polygon-mainnet', token: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
]
const rpcByChainId: Record<number, string> = {
  1: 'eth-mainnet',
  56: 'bnb-mainnet',
  137: 'polygon-mainnet',
}
const lifiDistributionAmount = 1_000_000n
const lifiDistributionTotal = lifiDistributionAmount * 2n
const lifiDistributionTargets = [
  { chainId: 137, token: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', amount: lifiDistributionAmount },
  { chainId: 56, token: '0x55d398326f99059fF775485246999027B3197955', amount: lifiDistributionAmount },
]
const ethereumUsdcToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const bridgeTargetTokens = {
  bnbUsdt: '0x55d398326f99059fF775485246999027B3197955',
  polygonPusd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
}
const lifiDiamondAddress = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'

type SourcePlatform = 'polymarket' | 'predictfun'
type OrderBookPlatform = SourcePlatform | 'combined'

type MarketSource = {
  platform: SourcePlatform
  outcome?: OutcomeSide
  marketId?: string
  tokenId?: string
  yesTokenId?: string
  noTokenId?: string
}

type Market = {
  id: string
  title: string
  question: string
  image: string
  yesPrice: string
  noPrice: string
  yesTokenId: string
  noTokenId: string
  volume?: number | string | null
  sources?: MarketSource[]
}

type Event = {
  id: string
  slug?: string | null
  title?: string | null
  image?: string | null
  volume?: number | string | null
  markets?: Market[] | null
}

type Order = {
  price: string
  size: string
  platform?: OrderBookPlatform
}

type OrderBook = {
  asks: Order[]
  bids: Order[]
}

type Quote = {
  spent: number
  unspent: number
  shares: number
  avgPrice: number
  payoutIfWin: number
  profitIfWin: number
  filled: boolean
  levels: Array<{
    platform: SourcePlatform
    price: string
    shares: number
    cost: number
  }>
}

type ApprovalItem = {
  id: string
  type: string
  chain?: string
  chainId?: number
  token: string
  spender: string
  approved: boolean
  allowance?: string
}

type PlatformApprovals = {
  platform: string
  chainId?: number
  ready: boolean
  approvals: ApprovalItem[]
  error?: unknown
}

type ApprovalsResponse = {
  wallet: string
  ready: boolean
  platforms: PlatformApprovals[]
}

type EvmPrimaryWallet = {
  address: string
  connector?: {
    signAuthorization?: (params: {
      address: `0x${string}`
      chainId: number
      nonce: bigint
    }) => Promise<`0x${string}` | { r: `0x${string}`; s: `0x${string}`; yParity?: number; v?: bigint }>
    signMessage?: (message: string) => Promise<`0x${string}` | string | undefined>
    signRawMessage?: (params: { accountAddress: string; message: string }) => Promise<`0x${string}` | string | undefined>
  }
  getWalletClient: (chainId?: string) => Promise<unknown>
}

type WalletClientWithRequest = {
  request?: (params: { method: string; params?: unknown[] }) => Promise<unknown>
}

type WalletClientWithTypedData = WalletClientWithRequest & {
  signTypedData?: (params: {
    account?: string
    domain: Record<string, unknown>
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    message: Record<string, unknown>
  }) => Promise<`0x${string}`>
}

type PolymarketOrderConfig = {
  chainId: number
  tickSize: string
  negRisk: boolean
  feeRateBps: number
  exchange: string
}

type UsdcChainBalance = {
  chainId: number
  token: string
  balance: bigint
}

type ComposerTarget = {
  chainId: number
  token: string
  amount: bigint
}

type ComposerTransactionRequest = {
  to: string
  data?: string
  value?: string
  gasLimit?: string
  gasPrice?: string
}

type ComposerCompileResult = {
  status: string
  userProxy?: string
  approvals?: Array<{
    transactionRequest?: ComposerTransactionRequest
  }>
  transactionRequest?: ComposerTransactionRequest
  simulationRevert?: unknown
}

type ComposerSimulationPolicy = 'strict' | 'allow-revert'

type LifiQuoteResponse = {
  message?: string
  transactionRequest?: {
    to?: string
    data?: string
    value?: string
  }
}

type LifiRoute = {
  id?: string
  toAmount?: string
  toAmountMin?: string
  gasCostUSD?: string
  steps?: Array<{
    tool?: string
    estimate?: {
      executionDuration?: number
      toAmount?: string
      toAmountMin?: string
    }
  }>
}

type LifiRoutesResponse = {
  message?: string
  routes?: LifiRoute[]
}

type LifiDiamondQuote = {
  transactionRequest: {
    to: string
    data: string
    value?: string
  }
}

type EvmTransactionRequest = {
  to: string
  data?: string
  value?: string
  gasLimit?: string
  gasPrice?: string
}

type Erc20ApprovalCall = {
  token: string
  spender: string
  amount: bigint
}

type BridgeMode = 'split' | 'bnb'

type ComposeSdkLike = {
  flow: (chainId: number, config: {
    name: string
    inputs: Record<string, unknown>
  }) => {
    inputs: Record<string, unknown>
    context: { sender: unknown; executionAddress: unknown }
    core: {
      split: (id: string, params: {
        bind: { source: unknown }
        config: { bps: number }
      }) => { a: unknown; b: unknown }
      transfer: (id: string, params: {
        bind: { amount: unknown; recipient: unknown }
        config: { amount?: string }
      }) => unknown
      approve: (id: string, params: {
        bind: { amount: unknown }
        config: { spender: string }
      }) => unknown
      call: (id: string, params: {
        resource?: unknown
        bind: Record<string, unknown>
        config: { target: string; functionSignature: string }
      }) => unknown
      balanceOf: (id: string, params: {
        bind: Record<string, never>
        config: { token: string; owner: string }
      }) => { balance: unknown }
      staticCall: (id: string, params: {
        bind: Record<string, never>
        config: { target: string; functionSignature: string }
      }) => unknown
      rawCall: (id: string, params: {
        bind: Record<string, never>
        config: { target: string; calldata: string; callType: 'Call' }
      }) => unknown
    }
    lifi: {
      swap: (id: string, params: {
        bind: { amountIn: unknown }
        config: { resourceOut: unknown; slippage: number }
      }) => unknown
    }
    compile: (params: unknown) => Promise<ComposerCompileResult>
  }
}

type OutcomeSide = 'yes' | 'no'
const orderBookPlatforms: OrderBookPlatform[] = ['combined', 'predictfun', 'polymarket']

function formatPercent(value?: string) {
  const price = Number(value ?? 0)
  return `${Math.round(price * 100)}%`
}

function formatCents(value?: string) {
  const price = Number(value ?? 0)
  return `${(price * 100).toFixed(1)}c`
}

function formatVolume(value?: number | string | null) {
  const volume = Number(value ?? 0)

  if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(1)}B Vol.`
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M Vol.`

  return `$${Math.round(volume).toLocaleString()} Vol.`
}

function formatShares(value: string) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatTotal(order: Order) {
  return `$${(Number(order.price) * Number(order.size)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`
}

function formatUsd(value?: number) {
  return `$${Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatAmountInput(value: string) {
  if (!value) return ''

  const [integer, decimal] = value.split('.')
  const formattedInteger = Number(integer || 0).toLocaleString()

  return decimal === undefined ? formattedInteger : `${formattedInteger}.${decimal}`
}

function parseAmountInput(value: string) {
  const normalized = value.replace(/,/g, '').replace(/[^\d.]/g, '')
  const [integer, ...decimalParts] = normalized.split('.')
  const decimal = decimalParts.join('')

  return decimalParts.length > 0 ? `${integer}.${decimal}` : integer
}

function encodeRpcAddress(value: string) {
  return value.toLowerCase().replace('0x', '').padStart(64, '0')
}

function parseTokenAmount(value: string) {
  const [integer, decimal = ''] = value.replace(/,/g, '').split('.')
  const whole = BigInt(integer || '0') * 1_000_000n
  const fraction = BigInt(decimal.slice(0, 6).padEnd(6, '0') || '0')

  return whole + fraction
}

function getQuoteRoutes(quote: Quote) {
  const costByPlatform = new Map<SourcePlatform, number>()

  quote.levels.forEach((level) => {
    costByPlatform.set(level.platform, (costByPlatform.get(level.platform) ?? 0) + level.cost)
  })

  const totalCost = [...costByPlatform.values()].reduce((total, cost) => total + cost, 0)

  return [...costByPlatform.entries()]
    .map(([platform, cost]) => ({
      platform,
      cost,
      percent: totalCost ? (cost / totalCost) * 100 : 0,
    }))
    .sort((first, second) => second.cost - first.cost)
}

function routeColor(platform: SourcePlatform) {
  return platform === 'polymarket' ? '#86efac' : '#60a5fa'
}

function routeChart(routes: ReturnType<typeof getQuoteRoutes>) {
  if (routes.length === 0) return '#263244'

  let cursor = 0
  const stops = routes.map((route) => {
    const start = cursor
    cursor += route.percent
    return `${routeColor(route.platform)} ${start}% ${cursor}%`
  })

  return `conic-gradient(${stops.join(', ')})`
}

function platformLabel(platform: OrderBookPlatform) {
  if (platform === 'polymarket') return 'Polymarket'
  if (platform === 'predictfun') return 'PredictFun'

  return 'Combined'
}

function approvalPlatformLabel(platform: string) {
  if (platform === 'polymarket') return 'Polymarket'
  if (platform === 'predictfun') return 'PredictFun'
  if (platform === 'lifi') return 'Li.Fi'

  return platform
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function getEventSlugFromPath() {
  return window.location.pathname.replace(/^\/+/, '')
}

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) throw new Error(await response.text())

  return response.json() as Promise<T>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs)

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => window.clearTimeout(timeoutId))
  })
}

function compactJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_, nextValue) => {
    if (typeof nextValue === 'bigint') return nextValue.toString()
    if (typeof nextValue === 'string' && nextValue.length > 180) return `${nextValue.slice(0, 90)}...${nextValue.slice(-30)}`

    return nextValue
  }))
}

function describeError(error: unknown) {
  if (error && typeof error === 'object') {
    const maybeError = error as {
      cause?: unknown
      details?: unknown
      kind?: string
      message?: string
      name?: string
      path?: string
      response?: { status?: number; data?: unknown }
      status?: number
      code?: string
      walk?: () => Error | undefined
    }
    const rootError = maybeError.walk?.()
    const fallbackMessage = [
      maybeError.kind,
      maybeError.code,
      maybeError.status ? `status ${maybeError.status}` : '',
      typeof maybeError.details === 'string' ? maybeError.details : '',
    ].filter(Boolean).join(': ')

    return {
      message: maybeError.message || fallbackMessage || maybeError.name,
      status: maybeError.response?.status ?? maybeError.status,
      code: maybeError.code,
      details: maybeError.details,
      kind: maybeError.kind,
      path: maybeError.path,
      data: maybeError.response?.data,
      cause: maybeError.cause,
      rootMessage: rootError?.message,
      rootName: rootError?.name,
    }
  }

  return { message: String(error) }
}

function debugLog(event: string, data: unknown = {}) {
  console.log(`[OddRouter debug] ${event}`, data)
  fetch(`${apiBaseUrl}/api/debug/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, data: compactJson(data) }),
  }).catch(() => undefined)
}

function App() {
  const { primaryWallet, setShowDynamicUserProfile, showDynamicUserProfile } = useDynamicContext()
  const { openFundingOptions } = useOpenFundingOptions()
  const userWallets = useUserWallets()
  const walletAddress = primaryWallet?.address
  const orderBookTableRef = useRef<HTMLDivElement | null>(null)
  const spreadRowRef = useRef<HTMLDivElement | null>(null)
  const depositWidgetWasOpenRef = useRef(false)
  const depositInitialBalancesRef = useRef<Record<number, bigint>>({})
  const composerProxyByChainRef = useRef<Record<string, string>>({})
  const [events, setEvents] = useState<Event[]>([])
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [expandedMarketId, setExpandedMarketId] = useState('')
  const [selectedOutcome, setSelectedOutcome] = useState<OutcomeSide>('yes')
  const [selectedOrderBookPlatform, setSelectedOrderBookPlatform] = useState<OrderBookPlatform>('combined')
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null)
  const [orderBookLoading, setOrderBookLoading] = useState(false)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [buyStatus, setBuyStatus] = useState<'idle' | 'signing' | 'submitted' | 'error'>('idle')
  const [buyError, setBuyError] = useState('')
  const [approvals, setApprovals] = useState<ApprovalsResponse | null>(null)
  const [approvalsLoading, setApprovalsLoading] = useState(false)
  const [approvalsError, setApprovalsError] = useState('')
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [approveTxStatus, setApproveTxStatus] = useState('')
  const [approveTxPending, setApproveTxPending] = useState(false)
  const [depositStarted, setDepositStarted] = useState(false)
  const [depositWaitingOpen, setDepositWaitingOpen] = useState(false)
  const [depositStatus, setDepositStatus] = useState<'waiting' | 'success'>('waiting')
  const [bridgeOpen, setBridgeOpen] = useState(false)
  const [bridgeMode, setBridgeMode] = useState<BridgeMode>('split')
  const [bridgeAmount, setBridgeAmount] = useState('')
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [bridgeError, setBridgeError] = useState('')
  const [returnDepositOpen, setReturnDepositOpen] = useState(false)
  const [returnDepositStatus, setReturnDepositStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [returnDepositError, setReturnDepositError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function loadEvents() {
      try {
        const loadedEvents = await Promise.all(
          eventSlugs.map((eventSlug) => fetchApi<Event>(`/api/merged-events/${eventSlug}`)),
        )
        const eventSlug = getEventSlugFromPath()
        const eventFromUrl = loadedEvents.find((event) => event.slug === eventSlug)

        setEvents(loadedEvents)

        if (eventFromUrl) {
          const markets = eventFromUrl.markets as Market[] | undefined
          setSelectedEvent(eventFromUrl)
          setSelectedMarketId(markets?.[0]?.id ?? '')
          setExpandedMarketId('')
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to load market')
      } finally {
        setLoading(false)
      }
    }

    loadEvents()
  }, [])

  useEffect(() => {
    function syncEventFromUrl() {
      const eventSlug = getEventSlugFromPath()
      const eventFromUrl = events.find((event) => event.slug === eventSlug)

      setSelectedEvent(eventFromUrl ?? null)
      setSelectedMarketId(eventFromUrl ? ((eventFromUrl.markets as Market[] | undefined)?.[0]?.id ?? '') : '')
      setExpandedMarketId('')
      setSelectedOutcome('yes')
      setSelectedOrderBookPlatform('combined')
    }

    window.addEventListener('popstate', syncEventFromUrl)
    return () => window.removeEventListener('popstate', syncEventFromUrl)
  }, [events])

  useEffect(() => {
    async function loadApprovals() {
      if (!walletAddress) {
        setApprovals(null)
        setApprovalsOpen(false)
        return
      }

      try {
        const loadedApprovals = await fetchApprovalsStatus()
        setApprovalsOpen(!loadedApprovals.ready)
      } catch (error) {
        setApprovalsOpen(true)
      }
    }

    loadApprovals()
  }, [walletAddress])

  useEffect(() => {
    if (!depositStarted) return

    if (showDynamicUserProfile) {
      depositWidgetWasOpenRef.current = true
      return
    }

    if (depositWidgetWasOpenRef.current) {
      depositWidgetWasOpenRef.current = false
      setDepositStarted(false)
      setDepositStatus('waiting')
      setDepositWaitingOpen(true)
    }
  }, [depositStarted, showDynamicUserProfile])

  useEffect(() => {
    if (!depositStarted) return

    const originalLog = console.log
    const originalInfo = console.info
    const originalDebug = console.debug

    function handleConsoleMessage(args: unknown[]) {
      if (args.some((arg) => String(arg).includes('Funding with wallet succeeded'))) {
        showDepositWaiting()
      }
    }

    console.log = (...args: unknown[]) => {
      handleConsoleMessage(args)
      originalLog(...args)
    }
    console.info = (...args: unknown[]) => {
      handleConsoleMessage(args)
      originalInfo(...args)
    }
    console.debug = (...args: unknown[]) => {
      handleConsoleMessage(args)
      originalDebug(...args)
    }

    return () => {
      console.log = originalLog
      console.info = originalInfo
      console.debug = originalDebug
    }
  }, [depositStarted])

  useEffect(() => {
    if (!depositStarted && (!depositWaitingOpen || depositStatus !== 'waiting')) return

    let cancelled = false

    async function waitForDeposit() {
      while (!cancelled) {
        try {
          const balances = await fetchUsdcBalances()
          const source = balances.find((balance) => (
            balance.balance - (depositInitialBalancesRef.current[balance.chainId] ?? 0n) >= lifiDistributionTotal
          ))

          if (source) {
            showDepositWaiting()
            await runLifiDistribution(source)
            finishDeposit()
            return
          }
        } catch {
          // Keep waiting while Dynamic/onramp settles.
        }

        await new Promise((resolve) => window.setTimeout(resolve, 3_000))
      }
    }

    waitForDeposit()

    return () => {
      cancelled = true
    }
  }, [depositStarted, depositWaitingOpen, depositStatus, setShowDynamicUserProfile, walletAddress])

  const placeholderCards = Array.from(
    { length: Math.max(0, 9 - events.length) },
    (_, index) => index + 1,
  )
  const selectedMarkets = [...(selectedEvent?.markets ?? [])] as Market[]
  const selectedMarket = selectedMarkets.find((market) => market.id === selectedMarketId) ?? selectedMarkets[0]
  const expandedMarket = selectedMarkets.find((market) => market.id === expandedMarketId)
  const asks = orderBook?.asks ?? []
  const bids = orderBook?.bids ?? []
  const approvalsReady = approvals?.ready === true
  const approvalsPending = approvalsLoading || (!approvals && !approvalsError)

  async function fetchApprovalsStatus() {
    if (!walletAddress) throw new Error('Connect wallet first')

    setApprovalsLoading(true)
    setApprovalsError('')

    try {
      const lifiApprovalSpenders = await Promise.all([
        getComposerProxyForChain(1, ethereumUsdcToken),
        getComposerProxyForChain(56, bridgeTargetTokens.bnbUsdt),
        getComposerProxyForChain(137, bridgeTargetTokens.polygonPusd),
      ])
      const lifiSpender = [
        `1:${lifiApprovalSpenders[0]}`,
        `56:${lifiApprovalSpenders[1]}`,
        `137:${lifiApprovalSpenders[2]}`,
      ].join(',')
      const params = new URLSearchParams({
        wallet: walletAddress,
        platform: 'all',
        tokens: lifiApprovalTokens,
        lifiSpender,
        minAmount: lifiApprovalMinAmount,
      })
      const loadedApprovals = await fetchApi<ApprovalsResponse>(`/api/approvals?${params.toString()}`)
      setApprovals(loadedApprovals)
      return loadedApprovals
    } catch (error) {
      setApprovalsError(error instanceof Error ? error.message : 'Failed to load approvals')
      throw error
    } finally {
      setApprovalsLoading(false)
    }
  }

  async function getComposerProxyForChain(chainId: number, token: string) {
    if (!walletAddress) throw new Error('Connect wallet first')
    if (!lifiComposerApiKey) throw new Error('Missing VITE_LIFI_API_KEY')

    const cacheKey = `${walletAddress.toLowerCase()}:${chainId}:${token.toLowerCase()}`
    const cachedProxy = composerProxyByChainRef.current[cacheKey]
    if (cachedProxy) return cachedProxy

    const sdk = createComposeSdk({
      baseUrl: lifiComposerBaseUrl,
      apiKey: lifiComposerApiKey,
    }) as unknown as ComposeSdkLike
    const builder = sdk.flow(chainId, {
      name: 'oddrouter-approval-proxy-probe',
      inputs: {},
    })

    builder.core.staticCall('total-supply', {
      bind: {},
      config: {
        target: token,
        functionSignature: 'function totalSupply() view returns (uint256)',
      },
    })

    const result = await builder.compile({
      simulationPolicy: 'strict',
      checkOnChainAllowances: true,
      signer: walletAddress,
      inputs: {},
    })
    if (!result.userProxy) throw new Error('Composer did not return user proxy')

    composerProxyByChainRef.current[cacheKey] = result.userProxy
    return result.userProxy
  }

  async function fetchUsdcBalances() {
    if (!walletAddress) return []

    return Promise.all(usdcBalanceTokens.map(async ({ chainId, rpc, token }) => {
      return {
        chainId,
        token,
        balance: await fetchTokenBalance(rpc, token),
      }
    }))
  }

  async function fetchTokenBalance(rpc: string, token: string) {
    if (!walletAddress) return 0n
    if (!alchemyApiKey) throw new Error('Missing VITE_ALCHEMY_API_KEY')

    const response = await fetch(`https://${rpc}.g.alchemy.com/v2/${alchemyApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: token,
            data: `0x70a08231${encodeRpcAddress(walletAddress)}`,
          },
          'latest',
        ],
      }),
    })
    const result = await response.json() as { result?: string; error?: unknown }
    if (result.error) throw new Error(JSON.stringify(result.error))

    return BigInt(result.result ?? '0x0')
  }

  async function fetchTokenAllowance(rpc: string, token: string, owner: string, spender: string) {
    if (!alchemyApiKey) throw new Error('Missing VITE_ALCHEMY_API_KEY')

    const response = await fetch(`https://${rpc}.g.alchemy.com/v2/${alchemyApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: token,
            data: `0xdd62ed3e${encodeRpcAddress(owner)}${encodeRpcAddress(spender)}`,
          },
          'latest',
        ],
      }),
    })
    const result = await response.json() as { result?: string; error?: unknown }
    if (result.error) throw new Error(JSON.stringify(result.error))

    return BigInt(result.result ?? '0x0')
  }

  function showDepositWaiting() {
    depositWidgetWasOpenRef.current = false
    setDepositStarted(false)
    setShowDynamicUserProfile(false)
    setDepositWaitingOpen(true)
    setDepositStatus('waiting')
  }

  function finishDeposit() {
    depositWidgetWasOpenRef.current = false
    setDepositStarted(false)
    setShowDynamicUserProfile(false)
    setDepositWaitingOpen(true)
    setDepositStatus('success')
  }

  async function runLifiDistribution(source: UsdcChainBalance) {
    const wallet = primaryWallet as unknown as EvmPrimaryWallet | undefined
    if (!walletAddress || !wallet) throw new Error('Connect wallet first')

    const pendingTargets = lifiDistributionTargets.filter((target) => !(
      source.chainId === target.chainId && source.token.toLowerCase() === target.token.toLowerCase()
    ))
    const destinationStartBalances = await fetchLifiTargetBalances(pendingTargets)
    await runComposerFlow(wallet, source, pendingTargets)
    await waitForLifiTargetBalances(pendingTargets, destinationStartBalances)
  }

  async function runBridgeTokens() {
    const amount = parseTokenAmount(bridgeAmount)
    if (amount <= 0n) return

    const half = amount / 2n
    if (half <= 0n) return

    setBridgeStatus('waiting')
    setBridgeError('')

    try {
      const wallet = primaryWallet as unknown as EvmPrimaryWallet | undefined

      if (!walletAddress || !wallet) throw new Error('Connect wallet first')

      const sourceBalance = await fetchTokenBalance('eth-mainnet', ethereumUsdcToken)
      if (sourceBalance < amount) throw new Error('No Ethereum USDC balance')

      const source = {
        chainId: 1,
        rpc: 'eth-mainnet',
        token: ethereumUsdcToken,
        balance: sourceBalance,
      }
      const targets = bridgeMode === 'bnb'
        ? [{
          chainId: 56,
          rpc: 'bnb-mainnet',
          token: bridgeTargetTokens.bnbUsdt,
          amount,
        }]
        : [
          {
            chainId: 137,
            rpc: 'polygon-mainnet',
            token: bridgeTargetTokens.polygonPusd,
            amount: amount - half,
          },
          {
            chainId: 56,
            rpc: 'bnb-mainnet',
            token: bridgeTargetTokens.bnbUsdt,
            amount: half,
          },
        ]
      const destinationStartBalances = await fetchLifiTargetBalances(targets)
      debugLog('bridge:composer', targets.map((target) => ({
        target: `${target.chainId}:${target.token}`,
        amount: target.amount.toString(),
      })))

      if (bridgeMode === 'bnb') {
        await runComposerFlow(wallet, source, targets, 'strict')
      } else {
        for (const target of targets) {
          await runComposerFlow(wallet, source, [target], 'strict')
        }
      }
      await waitForLifiTargetBalances(targets, destinationStartBalances)
      setBridgeStatus('success')
    } catch (error) {
      const describedError = describeError(error)
      debugLog('bridge:error', describedError)
      setBridgeError(describedError.message ?? 'Bridge failed')
      setBridgeStatus('error')
    }
  }

  async function runReturnDeposit() {
    setReturnDepositStatus('waiting')
    setReturnDepositError('')

    try {
      const wallet = primaryWallet as unknown as EvmPrimaryWallet | undefined
      if (!walletAddress || !wallet) throw new Error('Connect wallet first')

      const sources = [
        {
          chainId: 56,
          rpc: 'bnb-mainnet',
          token: bridgeTargetTokens.bnbUsdt,
          balance: await fetchTokenBalance('bnb-mainnet', bridgeTargetTokens.bnbUsdt),
        },
        {
          chainId: 137,
          rpc: 'polygon-mainnet',
          token: bridgeTargetTokens.polygonPusd,
          balance: await fetchTokenBalance('polygon-mainnet', bridgeTargetTokens.polygonPusd),
        },
      ].filter((source) => source.balance > 0n)

      if (sources.length === 0) throw new Error('No BNB or Polygon deposit balance')

      for (const source of sources) {
        const target = [{
          chainId: 1,
          rpc: 'eth-mainnet',
          token: ethereumUsdcToken,
          amount: source.balance,
        }]
        const destinationStartBalances = await fetchLifiTargetBalances(target)
        debugLog('return-deposit:composer', {
          source: `${source.chainId}:${source.token}`,
          amount: source.balance.toString(),
          target: `1:${ethereumUsdcToken}`,
        })
        await runComposerFlow(wallet, source, target, 'strict')
        await waitForLifiTargetBalances(target, destinationStartBalances)
      }

      setReturnDepositStatus('success')
    } catch (error) {
      const describedError = describeError(error)
      debugLog('return-deposit:error', describedError)
      setReturnDepositError(describedError.message ?? 'Return deposit failed')
      setReturnDepositStatus('error')
    }
  }

  async function fetchLifiTargetBalances(targets: Array<{ chainId: number; token: string }> = lifiDistributionTargets) {
    const entries = await Promise.all(targets.map(async (target) => {
      const rpc = rpcByChainId[target.chainId]
      if (!rpc) throw new Error(`Unsupported chain: ${target.chainId}`)

      const balance = await fetchTokenBalance(rpc, target.token)
      return [`${target.chainId}:${target.token.toLowerCase()}`, balance] as const
    }))

    return Object.fromEntries(entries)
  }

  async function waitForLifiTargetBalances(
    targets: Array<{ chainId: number; token: string }>,
    startBalances: Record<string, bigint>,
  ) {
    if (targets.length === 0) return

    for (let attempt = 1; attempt <= 80; attempt += 1) {
      const balances = await fetchLifiTargetBalances(targets)
      const ready = targets.every((target) => {
        const key = `${target.chainId}:${target.token.toLowerCase()}`
        return (balances[key] ?? 0n) > (startBalances[key] ?? 0n)
      })

      if (ready) return
      await new Promise((resolve) => window.setTimeout(resolve, 3_000))
    }

    throw new Error('Li.Fi destination balances did not update')
  }

  async function getLifiDiamondQuote(
    source: UsdcChainBalance,
    target: ComposerTarget,
    fromAddress: string,
  ): Promise<LifiDiamondQuote> {
    if (!walletAddress) throw new Error('Connect wallet first')
    if (!lifiComposerApiKey) throw new Error('Missing VITE_LIFI_API_KEY')

    const routeRequestBase = {
        fromChainId: source.chainId,
        toChainId: target.chainId,
        fromTokenAddress: source.token,
        toTokenAddress: target.token,
        fromAmount: target.amount.toString(),
        fromAddress,
        toAddress: walletAddress,
    }
    const fetchRoutes = async (order: 'CHEAPEST' | 'FASTEST') => {
      const response = await fetch('https://li.quest/v1/advanced/routes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lifi-api-key': lifiComposerApiKey,
        },
        body: JSON.stringify({
          ...routeRequestBase,
        options: {
          slippage: 0.03,
          integrator: 'oddrouter',
            order,
          allowSwitchChain: false,
          allowDestinationCall: false,
          executionType: 'transaction',
        },
        }),
      })
      const body = await response.json() as LifiRoutesResponse

      if (!response.ok) throw new Error(body.message ?? `Li.Fi ${order} routes failed`)
      return body.routes ?? []
    }

    const [cheapestRoutes, fastestRoutes] = await Promise.all([
      fetchRoutes('CHEAPEST'),
      fetchRoutes('FASTEST'),
    ])
    const routes = [...cheapestRoutes, ...fastestRoutes]
    const uniqueRoutes = Array.from(new Map(routes.map((route) => [route.id ?? Math.random().toString(), route])).values())

    const candidates = await Promise.all(uniqueRoutes.slice(0, 10).map(async (route) => {
      const step = route.steps?.[0]
      if (!step) return null

      const stepResponse = await fetch('https://li.quest/v1/advanced/stepTransaction', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lifi-api-key': lifiComposerApiKey,
        },
        body: JSON.stringify(step),
      })
      const stepQuote = await stepResponse.json() as LifiQuoteResponse
      if (!stepResponse.ok || !stepQuote.transactionRequest?.to || !stepQuote.transactionRequest.data) return null

      return {
        route,
        step,
        transactionRequest: {
          to: stepQuote.transactionRequest.to,
          data: stepQuote.transactionRequest.data,
          value: stepQuote.transactionRequest.value,
        },
      }
    }))

    const validCandidates = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .filter((candidate) => isZeroTransactionValue(candidate.transactionRequest.value))
      .filter((candidate) => candidate.transactionRequest.to.toLowerCase() === lifiDiamondAddress.toLowerCase())
    const cheapest = [...validCandidates]
      .sort((a, b) => Number(
        BigInt(b.route.toAmountMin ?? b.route.toAmount ?? '0') - BigInt(a.route.toAmountMin ?? a.route.toAmount ?? '0'),
      ))[0]
    const fastest = [...validCandidates]
      .sort((a, b) => getRouteDuration(a.route) - getRouteDuration(b.route))[0]

    const best = cheapest
    if (!best) {
      throw new Error('Li.Fi did not return a zero-value Diamond route')
    }

    debugLog('bridge:lifi-route', {
      fromAddress,
      routeId: best.route.id,
      checkedRoutes: uniqueRoutes.length,
      selected: 'cheapest',
      toAmount: best.route.toAmount,
      toAmountMin: best.route.toAmountMin,
      duration: getRouteDuration(best.route),
      gasCostUSD: best.route.gasCostUSD,
      tool: best.step.tool,
      fastest: fastest ? {
        routeId: fastest.route.id,
        tool: fastest.step.tool,
        toAmount: fastest.route.toAmount,
        toAmountMin: fastest.route.toAmountMin,
        duration: getRouteDuration(fastest.route),
        gasCostUSD: fastest.route.gasCostUSD,
      } : null,
      cheapest: cheapest ? {
        routeId: cheapest.route.id,
        tool: cheapest.step.tool,
        toAmount: cheapest.route.toAmount,
        toAmountMin: cheapest.route.toAmountMin,
        duration: getRouteDuration(cheapest.route),
        gasCostUSD: cheapest.route.gasCostUSD,
      } : null,
      txValue: best.transactionRequest.value ?? '0',
      selector: best.transactionRequest.data.slice(0, 10),
    })

    return {
      transactionRequest: best.transactionRequest,
    }
  }

  function isZeroTransactionValue(value?: string) {
    if (!value) return true
    return BigInt(value) === 0n
  }

  function getRouteDuration(route: LifiRoute) {
    return route.steps?.reduce((total, step) => total + (step.estimate?.executionDuration ?? 0), 0) ?? Number.MAX_SAFE_INTEGER
  }

  async function runComposerFlow(
    wallet: EvmPrimaryWallet,
    source: UsdcChainBalance,
    targets: ComposerTarget[],
    transactionSimulationPolicy: ComposerSimulationPolicy = 'strict',
  ) {
    if (targets.length === 1) {
      const approvalResult = await compileComposerFlow(source, targets, 'allow-revert')
      debugLog('composer:compile-before-approvals', {
        status: approvalResult.status,
        userProxy: approvalResult.userProxy,
        approvals: approvalResult.approvals?.length ?? 0,
        hasTransaction: Boolean(approvalResult.transactionRequest),
        simulationRevert: approvalResult.simulationRevert,
      })
      await sendComposerApprovals(wallet, source.chainId, approvalResult)

      const transactionResult = await compileComposerFlow(source, targets, transactionSimulationPolicy)
      debugLog('composer:compile-before-send', {
        status: transactionResult.status,
        userProxy: transactionResult.userProxy,
        approvals: transactionResult.approvals?.length ?? 0,
        hasTransaction: Boolean(transactionResult.transactionRequest),
        simulationRevert: transactionResult.simulationRevert,
      })
      if (transactionResult.transactionRequest) {
        debugLog('tenderly:simulation-payload', {
          network_id: String(source.chainId),
          from: wallet.address,
          to: transactionResult.transactionRequest.to,
          input: transactionResult.transactionRequest.data ?? '0x',
          value: toHexQuantity(transactionResult.transactionRequest.value ?? '0'),
          gas: transactionResult.transactionRequest.gasLimit ? Number(transactionResult.transactionRequest.gasLimit) : 8_000_000,
          save: true,
          save_if_fails: true,
        })
      }
      if (transactionResult.status !== 'success') return
      await sendComposerTransaction(wallet, source.chainId, transactionResult)
      return
    }

    const approvalResult = await compileComposerFlow(source, targets, 'allow-revert')
    await sendComposerApprovals(wallet, source.chainId, approvalResult)

    const transactionResult = await compileComposerFlow(source, targets, transactionSimulationPolicy)
    await sendComposerTransaction(wallet, source.chainId, transactionResult)
  }

  async function compileComposerFlow(
    source: UsdcChainBalance,
    targets: ComposerTarget[],
    simulationPolicy: ComposerSimulationPolicy,
  ) {
    if (!walletAddress) throw new Error('Connect wallet first')
    if (!lifiComposerApiKey) throw new Error('Missing VITE_LIFI_API_KEY')
    if (targets.length === 0) throw new Error('No Composer targets')

    const sdk = createComposeSdk({
      baseUrl: lifiComposerBaseUrl,
      apiKey: lifiComposerApiKey,
    }) as unknown as ComposeSdkLike
    const totalAmount = targets.reduce((total, target) => total + target.amount, 0n)
    const usesDiamondRawCall = targets.length === 1
    // let lifiDiamondSpender = lifiDiamondAddress
    let diamondUserProxy = ''
    let diamondSpender = ''
    const builder = sdk.flow(source.chainId, {
      name: usesDiamondRawCall ? 'oddrouter-diamond-bridge-bnb' : 'oddrouter-split-usdc',
      inputs: usesDiamondRawCall
        ? {
          amountIn: resources.erc20(source.token as `0x${string}`, source.chainId),
          proxyRecipient: 'address',
          diamondSpender: 'address',
        }
        : { amountIn: resources.erc20(source.token as `0x${string}`, source.chainId) },
    })

    if (usesDiamondRawCall) {
      const userProxy = await getComposerProxyForChain(source.chainId, source.token)
      diamondUserProxy = userProxy
      const quote = await getLifiDiamondQuote(source, targets[0], userProxy)
      const transactionRequest = quote.transactionRequest
      diamondSpender = transactionRequest.to
      // lifiDiamondSpender = transactionRequest.to

      debugLog('bridge:lifi-diamond', {
        to: transactionRequest.to,
        selector: transactionRequest.data.slice(0, 10),
      })

      builder.core.call('approve-lifi-diamond', {
        resource: builder.inputs.amountIn,
        bind: {
          spender: builder.inputs.diamondSpender,
          value: builder.inputs.amountIn,
        },
        config: {
          target: source.token,
          functionSignature: 'function approve(address spender, uint256 value)',
        },
      })
      const proxyBalanceAfterApprove = builder.core.balanceOf('read-proxy-usdc-balance-after-approve', {
        bind: {},
        config: {
          token: source.token,
          owner: userProxy,
        },
      })
      builder.core.transfer('transfer-proxy-balance-to-proxy', {
        bind: {
          amount: proxyBalanceAfterApprove.balance,
          recipient: builder.inputs.proxyRecipient,
        },
        config: { amount: '1' },
      })
      builder.core.rawCall('bridge-to-bnb', {
        bind: {},
        config: {
          target: transactionRequest.to,
          calldata: transactionRequest.data,
          callType: 'Call',
        },
      })
    } else {
      const { a, b } = builder.core.split('split', {
        bind: { source: builder.inputs.amountIn },
        config: { bps: 5000 },
      })
      const ports = [a, b]
      targets.slice(0, 2).forEach((target, index) => {
        builder.lifi.swap(`swap-target-${index}`, {
          bind: { amountIn: ports[index] },
          config: {
            resourceOut: resources.erc20(target.token as `0x${string}`, target.chainId),
            slippage: 0.03,
          },
        })
      })
    }

    return builder.compile({
      simulationPolicy,
      checkOnChainAllowances: true,
      signer: walletAddress,
      inputs: usesDiamondRawCall
        ? {
          amountIn: materialisers.directDeposit({ amount: totalAmount.toString() as `${bigint}` }),
          proxyRecipient: diamondUserProxy,
          diamondSpender,
        }
        : {
          amountIn: materialisers.directDeposit({ amount: totalAmount.toString() as `${bigint}` }),
        },
      ...(usesDiamondRawCall ? {} : { sweepTo: builder.context.sender }),
    })
  }

  async function sendComposerApprovals(wallet: EvmPrimaryWallet, chainId: number, result: ComposerCompileResult) {
    for (const approval of result.approvals ?? []) {
      if (approval.transactionRequest) {
        await sendSponsoredComposerTransaction(wallet, chainId, approval.transactionRequest)
        await waitForComposerApproval(chainId, approval.transactionRequest)
      }
    }
  }

  async function sendComposerTransaction(wallet: EvmPrimaryWallet, chainId: number, result: ComposerCompileResult) {
    if (!result.transactionRequest) throw new Error('Composer missing transaction')
    if (result.status !== 'success') {
      debugLog('composer:partial', {
        status: result.status,
        simulationRevert: result.simulationRevert,
      })
    }
    await sendSponsoredComposerTransaction(wallet, chainId, result.transactionRequest)
  }

  async function sendSponsoredComposerTransaction(wallet: EvmPrimaryWallet, chainId: number, transaction: EvmTransactionRequest) {
    if (!isAlchemyChainId(chainId)) {
      await sendEvmTransaction(wallet, chainId, transaction)
      return
    }

    const alchemySignerWallet = getAlchemySignerWallet() ?? wallet
    debugLog('tenderly:simulation-payload', {
      network_id: String(chainId),
      from: alchemySignerWallet.address,
      to: transaction.to,
      input: transaction.data ?? '0x',
      value: toHexQuantity(transaction.value ?? '0'),
      gas: transaction.gasLimit ? Number(transaction.gasLimit) : 8_000_000,
      gas_price: transaction.gasPrice ? toHexQuantity(transaction.gasPrice) : undefined,
      save: true,
      save_if_fails: true,
    })

    const prepared = await prepareAlchemyCalls({
      from: alchemySignerWallet.address,
      chainId,
      calls: [transactionToAlchemyCall(transaction)],
    })
    const walletClient = alchemySignerWallet.connector?.signRawMessage
      ? {}
      : await alchemySignerWallet.getWalletClient(String(chainId))
    const signedPreparedCalls = await signAlchemyPreparedCalls(
      prepared,
      walletClient as Parameters<typeof signAlchemyPreparedCalls>[1],
      alchemySignerWallet.address,
      alchemySignerWallet.connector,
      debugLog,
    )

    await sendAlchemyPreparedCalls({
      chainId,
      preparedCalls: signedPreparedCalls,
    })
  }

  async function sendEvmTransaction(wallet: EvmPrimaryWallet, chainId: number, transaction: EvmTransactionRequest) {
    if (!walletAddress) return

    const walletClient = await wallet.getWalletClient(String(chainId)) as WalletClientWithRequest
    if (!walletClient.request) throw new Error('No wallet request client')

    await walletClient.request({
      method: 'eth_sendTransaction',
      params: [{
        from: walletAddress,
        to: transaction.to,
        data: transaction.data,
        value: toHexQuantity(transaction.value ?? '0'),
        gas: transaction.gasLimit ? toHexQuantity(transaction.gasLimit) : undefined,
        gasPrice: transaction.gasPrice ? toHexQuantity(transaction.gasPrice) : undefined,
      }],
    })
  }

  function toHexQuantity(value: string) {
    if (value.startsWith('0x')) return value
    return `0x${BigInt(value).toString(16)}`
  }

  function transactionToAlchemyCall(transaction: EvmTransactionRequest): AlchemyCall {
    return {
      to: transaction.to as `0x${string}`,
      data: (transaction.data ?? '0x') as `0x${string}`,
      value: toHexQuantity(transaction.value ?? '0') as `0x${string}`,
    }
  }

  function isAlchemyChainId(chainId: number): chainId is AlchemyChainId {
    return chainId === 1 || chainId === 56 || chainId === 137
  }

  async function waitForComposerApproval(chainId: number, transaction: EvmTransactionRequest) {
    if (!walletAddress) return

    const approval = decodeErc20Approval(transaction)
    if (!approval) return

    const rpc = rpcByChainId[chainId]
    if (!rpc) return

    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const allowance = await fetchTokenAllowance(rpc, approval.token, walletAddress, approval.spender)
      if (allowance >= approval.amount) return
      await new Promise((resolve) => window.setTimeout(resolve, 2_000))
    }

    throw new Error('Composer approval did not update')
  }

  function decodeErc20Approval(transaction: EvmTransactionRequest): Erc20ApprovalCall | null {
    const data = transaction.data ?? ''
    if (!data.startsWith('0x095ea7b3') || data.length < 138) return null

    return {
      token: transaction.to,
      spender: `0x${data.slice(34, 74)}`,
      amount: BigInt(`0x${data.slice(74, 138)}`),
    }
  }

  async function fetchOrderBook(platform: SourcePlatform, market: Market) {
    if (platform === 'polymarket') {
      const tokenId = selectedOutcome === 'yes' ? market.yesTokenId : market.noTokenId
      if (!tokenId) return null

      const book = await fetchApi<OrderBook>(`/api/orderbook/${tokenId}?platform=polymarket`)
      return {
        asks: book.asks.map((order) => ({ ...order, platform })),
        bids: book.bids.map((order) => ({ ...order, platform })),
      }
    }

    const predictSource = market.sources?.find((source) => source.platform === 'predictfun')
    if (!predictSource?.marketId) return null

    const book = await fetchApi<OrderBook>(
      `/api/orderbook/${predictSource.marketId}?platform=predictfun&outcome=${selectedOutcome}`,
    )
    return {
      asks: book.asks.map((order) => ({ ...order, platform })),
      bids: book.bids.map((order) => ({ ...order, platform })),
    }
  }

  function mergeOrders(orders: Order[]) {
    const step = 0.001
    const liquidityByPrice = new Map<string, number>()

    orders.forEach((order) => {
      const price = Math.round(Number(order.price) / step) * step
      const priceKey = price.toFixed(3)
      const size = Number(order.size)

      if (!size) return

      liquidityByPrice.set(priceKey, (liquidityByPrice.get(priceKey) ?? 0) + size)
    })

    return [...liquidityByPrice.entries()]
      .map(([price, size]) => ({ price: String(Number(price)), size: String(size), platform: 'combined' as const }))
      .sort((a, b) => Number(b.price) - Number(a.price))
  }

  function mergeOrderBooks(books: OrderBook[]) {
    return {
      asks: mergeOrders(books.flatMap((book) => book.asks)),
      bids: mergeOrders(books.flatMap((book) => book.bids)),
    }
  }

  useEffect(() => {
    async function loadOrderBook() {
      if (!expandedMarket) {
        setOrderBook(null)
        return
      }

      setOrderBookLoading(true)

      try {
        if (selectedOrderBookPlatform === 'combined') {
          const books = await Promise.all([
            fetchOrderBook('polymarket', expandedMarket),
            fetchOrderBook('predictfun', expandedMarket),
          ])
          setOrderBook(mergeOrderBooks(books.filter(Boolean) as OrderBook[]))
          return
        }

        setOrderBook(await fetchOrderBook(selectedOrderBookPlatform, expandedMarket))
      } catch {
        setOrderBook(null)
      } finally {
        setOrderBookLoading(false)
      }
    }

    loadOrderBook()
  }, [expandedMarket, selectedOutcome, selectedOrderBookPlatform])

  useEffect(() => {
    if (!orderBook || orderBookLoading) return

    requestAnimationFrame(() => {
      const table = orderBookTableRef.current
      const spread = spreadRowRef.current

      if (!table || !spread) return

      table.scrollTop = spread.offsetTop - table.offsetTop - table.clientHeight / 2
    })
  }, [orderBook, orderBookLoading, selectedMarketId])

  useEffect(() => {
    async function loadQuote() {
      const value = Number(amount)
      const eventId = selectedEvent?.slug ?? ''

      if (!eventId || !selectedMarket?.id || value <= 0) {
        setQuote(null)
        return
      }

      const params = new URLSearchParams({
        event_id: eventId,
        market_id: selectedMarket.id,
        outcome: selectedOutcome,
        amount: String(value),
        platform: selectedOrderBookPlatform,
      })

      try {
        const nextQuote = await fetchApi<Quote>(`/api/combined-orderbook/quote?${params.toString()}`)
        setQuote(nextQuote.levels.length ? nextQuote : null)
      } catch {
        setQuote(null)
      }
    }

    loadQuote()
  }, [amount, selectedEvent?.slug, selectedMarket?.id, selectedOutcome, selectedOrderBookPlatform])

  function addAmount(value: number) {
    setAmount(String(Number(amount || 0) + value))
  }

  function toSixDecimals(value: number) {
    return String(Math.round(value * 1_000_000))
  }

  function randomSalt() {
    const values = new Uint32Array(4)
    crypto.getRandomValues(values)
    return values.reduce((result, value) => (result << 32n) + BigInt(value), 0n).toString()
  }

  function getPolymarketOrderInput() {
    if (!selectedMarket || !quote) throw new Error('Quote is missing')

    const polymarketLevels = quote.levels.filter((level) => level.platform === 'polymarket')
    if (polymarketLevels.length === 0) throw new Error('Quote has no Polymarket liquidity')

    const tokenId = selectedOutcome === 'yes' ? selectedMarket.yesTokenId : selectedMarket.noTokenId
    const shares = polymarketLevels.reduce((total, level) => total + Number(level.shares), 0)
    const cost = polymarketLevels.reduce((total, level) => total + Number(level.cost), 0)
    const worstPrice = Math.max(...polymarketLevels.map((level) => Number(level.price)))

    if (!tokenId || shares <= 0 || cost <= 0 || worstPrice <= 0) {
      throw new Error('Invalid Polymarket order input')
    }

    return {
      tokenId,
      shares,
      cost: worstPrice * shares,
      quoteCost: cost,
      price: worstPrice,
    }
  }

  async function signPolymarketOrder(order: Record<string, unknown>, config: PolymarketOrderConfig) {
    const wallet = primaryWallet as unknown as EvmPrimaryWallet | undefined
    if (!walletAddress || !wallet) throw new Error('Connect wallet first')

    const walletClient = await wallet.getWalletClient(String(config.chainId)) as WalletClientWithTypedData
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: config.chainId,
      verifyingContract: config.exchange,
    }
    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    }

    if (walletClient.signTypedData) {
      return walletClient.signTypedData({
        account: walletAddress,
        domain,
        types,
        primaryType: 'Order',
        message: order,
      })
    }

    if (!walletClient.request) throw new Error('Wallet does not support typed data signing')

    return walletClient.request({
      method: 'eth_signTypedData_v4',
      params: [walletAddress, JSON.stringify({
        domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...types,
        },
        primaryType: 'Order',
        message: order,
      })],
    }) as Promise<`0x${string}`>
  }

  async function buyPolymarketOrder() {
    setBuyStatus('signing')
    setBuyError('')

    try {
      if (!walletAddress) throw new Error('Connect wallet first')

      const input = getPolymarketOrderInput()
      const config = await fetchApi<PolymarketOrderConfig>(`/api/polymarket/order-config/${input.tokenId}`)
      const order = {
        salt: randomSalt(),
        maker: walletAddress,
        signer: walletAddress,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: input.tokenId,
        makerAmount: toSixDecimals(input.cost),
        takerAmount: toSixDecimals(input.shares),
        expiration: '0',
        nonce: '0',
        feeRateBps: String(config.feeRateBps),
        side: 0,
        signatureType: 0,
      }
      const signature = await signPolymarketOrder(order, config)
      const signedOrder = {
        ...order,
        side: 'BUY',
        signature,
      }

      debugLog('polymarket:order', {
        tokenId: input.tokenId,
        price: input.price,
        shares: input.shares,
        cost: input.cost,
        quoteCost: input.quoteCost,
      })

      await fetchApi('/api/polymarket/orders', {
        method: 'POST',
        body: JSON.stringify({
          owner: walletAddress,
          orderType: 'FOK',
          order: signedOrder,
        }),
      })
      setBuyStatus('submitted')
    } catch (error) {
      const describedError = describeError(error)
      debugLog('polymarket:order-error', describedError)
      setBuyError(describedError.message ?? 'Buy failed')
      setBuyStatus('error')
    }
  }

  async function openDeposit() {
    depositWidgetWasOpenRef.current = false
    try {
      const balances = await fetchUsdcBalances()
      depositInitialBalancesRef.current = Object.fromEntries(
        balances.map((balance) => [balance.chainId, balance.balance]),
      )
    } catch {
      depositInitialBalancesRef.current = {}
    }
    setDepositStarted(true)
    openFundingOptions()
  }

  async function approveAll() {
    await runApprovalAction('approve')
  }

  async function deapproveAll() {
    await runApprovalAction('deapprove')
  }

  async function runApprovalAction(action: 'approve' | 'deapprove') {
    setApproveTxStatus('')
    setApproveTxPending(true)

    try {
      const chains: AlchemyChainId[] = [1, 137, 56]
      const results = await Promise.allSettled(
        chains.map((chainId) => tryAlchemyApprove(chainId, true, action)),
      )
      const failedChains = results
        .map((result, index) => (result.status === 'rejected' ? getAlchemyChainLabel(chains[index]) : ''))
        .filter(Boolean)

      if (failedChains.length > 0) {
        setApproveTxStatus(`${action === 'approve' ? 'Approve' : 'Deapprove'} failed: ${failedChains.join(', ')}`)
        return
      }

      setApproveTxStatus('Waiting...')
      const checkedApprovals = await waitForApprovalResult(action)

      if (action === 'approve') {
        setApproveTxStatus(checkedApprovals.ready ? 'Approve All success' : 'Approve sent, but approvals are still missing')
        return
      }

      setApproveTxStatus(approvalsRevoked(checkedApprovals) ? 'Deapprove All success' : 'Deapprove sent, but approvals are still active')
    } catch (error) {
      const describedError = describeError(error)
      setApproveTxStatus(describedError.message ?? (action === 'approve' ? 'Approve All failed' : 'Deapprove All failed'))
    } finally {
      setApproveTxPending(false)
    }
  }

  async function waitForApprovalResult(action: 'approve' | 'deapprove') {
    let checkedApprovals = await fetchApprovalsStatus()

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const ready = action === 'approve' ? checkedApprovals.ready : approvalsRevoked(checkedApprovals)
      if (ready) return checkedApprovals

      await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      checkedApprovals = await fetchApprovalsStatus()
    }

    return checkedApprovals
  }

  function approvalsRevoked(checkedApprovals: ApprovalsResponse) {
    const approvalItems = checkedApprovals.platforms.flatMap((platform) => platform.approvals)
    return (
      approvalItems.length > 0
      && checkedApprovals.platforms.every((platform) => !platform.error)
      && approvalItems.every((approval) => !approval.approved)
    )
  }

  async function tryAlchemyApprove(chainId: AlchemyChainId, approveAll = false, action: 'approve' | 'deapprove' = 'approve') {
    const chainLabel = getAlchemyChainLabel(chainId)
    const allApprovals = getApprovalItemsWithChain()
    const alchemySignerWallet = getAlchemySignerWallet()
    debugLog('alchemy:start', {
      chainId,
      chainLabel,
      walletAddress,
      signerAddress: alchemySignerWallet?.address,
      hasConnector: Boolean(alchemySignerWallet?.connector),
      connectorMethods: alchemySignerWallet?.connector ? Object.keys(alchemySignerWallet.connector) : [],
      missingApprovals: allApprovals.filter((approval) => approval.chainId === chainId && !approval.approved).length,
    })

    if (!alchemySignerWallet) {
      setApproveTxStatus('Connect wallet first')
      return
    }

    const calls = buildAlchemyApprovalCalls(allApprovals, chainId, action)
    debugLog('alchemy:calls', calls)

    if (calls.length === 0) {
      if (!approveAll) {
        setApproveTxStatus(action === 'approve' ? `No missing ${chainLabel} approval` : `No ${chainLabel} approval to revoke`)
      }
      return
    }

    try {
      const prepared = await withTimeout(
        prepareAlchemyCalls({
          from: alchemySignerWallet.address,
          chainId,
          calls,
        }),
        15_000,
        'Alchemy prepare timed out',
      )
      debugLog('alchemy:prepared', prepared)
      console.log('Alchemy prepared calls', prepared)
      const walletClient = alchemySignerWallet.connector?.signRawMessage
        ? {}
        : await alchemySignerWallet.getWalletClient(String(chainId))
      debugLog('alchemy:wallet-client', {
        chainId,
        hasWalletClient: Boolean(walletClient),
        walletClientKeys: walletClient && typeof walletClient === 'object' ? Object.keys(walletClient) : [],
        usingConnectorRawSigner: Boolean(alchemySignerWallet.connector?.signRawMessage),
      })

      if (!walletClient) {
        setApproveTxStatus(`No wallet client for ${chainLabel}`)
        return
      }

      const signedPreparedCalls = await withTimeout(
        signAlchemyPreparedCalls(
          prepared,
          walletClient,
          alchemySignerWallet.address,
          alchemySignerWallet.connector,
          debugLog,
        ),
        60_000,
        'Wallet signing timed out',
      )
      debugLog('alchemy:signed', signedPreparedCalls)
      console.log('Alchemy signed prepared calls', signedPreparedCalls)

      const sent = await withTimeout(
        sendAlchemyPreparedCalls({
          chainId,
          preparedCalls: signedPreparedCalls,
        }) as Promise<{ id?: string; preparedCallIds?: string[] }>,
        20_000,
        'Alchemy send timed out',
      )
      debugLog('alchemy:sent', sent)
      console.log('Alchemy send response', sent)
    } catch (error) {
      const describedError = describeError(error)
      debugLog('alchemy:error', describedError)
      setApproveTxStatus(describedError.message ?? 'Alchemy approve failed')
      if (approveAll) throw error
    }
  }

  function getAlchemySignerWallet() {
    const wallets = [primaryWallet, ...userWallets].filter(Boolean) as unknown as EvmPrimaryWallet[]

    return wallets.find((wallet) => wallet.connector?.signAuthorization) ?? wallets[0]
  }

  function getAlchemyChainLabel(chainId: AlchemyChainId) {
    if (chainId === 1) return 'Ethereum'
    if (chainId === 137) return 'Polygon'
    return 'BNB'
  }

  function getApprovalItemsWithChain() {
    return approvals?.platforms.flatMap((platform) => (
      platform.approvals.map((approval) => ({
        ...approval,
        chainId: approval.chainId ?? platform.chainId,
      }))
    )) ?? []
  }

  return (
    <main className="app">
      <header className="header">
        <div className="header-left">
          <button
            className="brand"
            type="button"
            onClick={() => {
              window.history.pushState(null, '', '/')
              setSelectedEvent(null)
              setSelectedMarketId('')
              setExpandedMarketId('')
              setSelectedOutcome('yes')
              setSelectedOrderBookPlatform('combined')
              setOrderBook(null)
              setQuote(null)
            }}
          >
            <span className="brand-mark">O</span>
            <span>OddRouter</span>
          </button>
        </div>

        <div className="header-actions">
          {walletAddress && (
            <button className="deposit-button" type="button" onClick={openDeposit}>
              Deposit USDC
            </button>
          )}
          {walletAddress && (
            <button
              className="deposit-button"
              type="button"
              onClick={() => {
                setBridgeStatus('idle')
                setBridgeError('')
                setBridgeMode('split')
                setBridgeOpen(true)
              }}
            >
              Bridge tokens
            </button>
          )}
          {walletAddress && (
            <button
              className="deposit-button"
              type="button"
              onClick={() => {
                setBridgeStatus('idle')
                setBridgeError('')
                setBridgeMode('bnb')
                setBridgeOpen(true)
              }}
            >
              Bridge BNB
            </button>
          )}
          {walletAddress && (
            <button
              className="deposit-button"
              type="button"
              disabled={returnDepositStatus === 'waiting'}
              onClick={() => {
                setReturnDepositStatus('idle')
                setReturnDepositError('')
                setReturnDepositOpen(true)
              }}
            >
              Return deposit
            </button>
          )}
          {walletAddress && (
            <button
              className={approvalsPending ? 'approval-pill loading' : approvalsReady ? 'approval-pill ok' : 'approval-pill missing'}
              type="button"
              onClick={() => setApprovalsOpen(true)}
            >
              <span className={approvalsPending ? 'approval-pill-spinner' : 'approval-pill-dot'} />
              Approved
            </button>
          )}
          <div className="wallet">
            <DynamicWidget />
          </div>
        </div>
      </header>

      <section className="hero">
        {!selectedEvent && (
          <div className="intro">
            <p>OddRouter</p>
            <h1>Best prices across prediction markets.</h1>
            <span>Compare outcomes, discover liquidity, and route to the best venue.</span>
          </div>
        )}

        {loading && <p className="state">Loading Polymarket event...</p>}
        {error && <p className="state error">{error}</p>}

        {selectedEvent && selectedMarket ? (
          <section className="detail-view">
            <div className="markets-panel">
              <div className="detail-head">
                <img src={selectedEvent.image ?? ''} alt="" />
                <h2>{selectedEvent.title?.trim()}</h2>
              </div>

              <div className="detail-list">
                {selectedMarkets.map((market) => {
                  const isSelected = market.id === selectedMarket.id
                  const isExpanded = market.id === expandedMarketId

                  return (
                    <div className="detail-market" key={market.id}>
                      <div
                        className={isSelected ? 'detail-row selected' : 'detail-row'}
                        onClick={() => {
                          setSelectedMarketId(market.id)
                          setExpandedMarketId(isExpanded ? '' : market.id)
                          setSelectedOutcome('yes')
                          setSelectedOrderBookPlatform('combined')
                        }}
                      >
                        <img src={market.image || selectedEvent.image || ''} alt="" />
                        <div className="detail-title">
                          <strong>{market.title}</strong>
                          <span>{formatVolume(market.volume)}</span>
                        </div>
                        <strong className="detail-price">{formatPercent(market.yesPrice)}</strong>
                        <span className="detail-change">▲ 1%</span>
                        <button
                          className={isExpanded && selectedOutcome === 'yes' ? 'detail-buy yes active' : 'detail-buy yes'}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedMarketId(market.id)
                            setExpandedMarketId(market.id)
                            setSelectedOutcome('yes')
                            setSelectedOrderBookPlatform('combined')
                          }}
                        >
                          Buy Yes {formatCents(market.yesPrice)}
                        </button>
                        <button
                          className={isExpanded && selectedOutcome === 'no' ? 'detail-buy no active' : 'detail-buy no'}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedMarketId(market.id)
                            setExpandedMarketId(market.id)
                            setSelectedOutcome('no')
                            setSelectedOrderBookPlatform('combined')
                          }}
                        >
                          Buy No {formatCents(market.noPrice)}
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="orderbook">
                          <div className="orderbook-tabs">
                            <div className="orderbook-platforms">
                              {orderBookPlatforms.map((platform) => (
                                <button
                                  className={selectedOrderBookPlatform === platform ? 'active' : ''}
                                  key={platform}
                                  type="button"
                                  onClick={() => setSelectedOrderBookPlatform(platform)}
                                >
                                  {platformLabel(platform)}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="orderbook-table" ref={orderBookTableRef}>
                            <div className="orderbook-header">
                              <span></span>
                              <span>Price</span>
                              <span>Shares</span>
                              <span>Total</span>
                            </div>

                            {orderBookLoading && <p className="orderbook-state">Loading order book...</p>}

                            {!orderBookLoading && asks.length === 0 && bids.length === 0 && (
                              <p className="orderbook-state">No liquidity</p>
                            )}

                            {!orderBookLoading && (asks.length > 0 || bids.length > 0) && (
                              <>
                                <div className="orderbook-side asks">
                                  <span className="side-label">Asks</span>
                                  {asks.map((order) => (
                                    <div className="order-row" key={`ask-${order.platform}-${order.price}-${order.size}`}>
                                      <span></span>
                                      <strong>{formatCents(order.price)}</strong>
                                      <span>{formatShares(order.size)}</span>
                                      <span>{formatTotal(order)}</span>
                                    </div>
                                  ))}
                                </div>

                                <div className="spread-row" ref={spreadRowRef}>
                                  <span>Last: {formatCents(selectedOutcome === 'yes' ? market.yesPrice : market.noPrice)}</span>
                                  <span>Spread: 0.1c</span>
                                </div>

                                <div className="orderbook-side bids">
                                  <span className="side-label">Bids</span>
                                  {bids.map((order) => (
                                    <div className="order-row" key={`bid-${order.platform}-${order.price}-${order.size}`}>
                                      <span></span>
                                      <strong>{formatCents(order.price)}</strong>
                                      <span>{formatShares(order.size)}</span>
                                      <span>{formatTotal(order)}</span>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            <aside className="bet-card">
              <div className="bet-head">
                <img src={selectedMarket.image || selectedEvent.image || ''} alt="" />
                <div>
                  <span>{selectedEvent.title?.trim()}</span>
                  <strong>{selectedMarket.title}</strong>
                </div>
              </div>

              <div className="bet-outcomes">
                <button
                  className={selectedOutcome === 'yes' ? 'yes active' : 'yes'}
                  type="button"
                  onClick={() => {
                    setExpandedMarketId(selectedMarket.id)
                    setSelectedOutcome('yes')
                    setSelectedOrderBookPlatform('combined')
                  }}
                >
                  Yes {formatCents(selectedMarket.yesPrice)}
                </button>
                <button
                  className={selectedOutcome === 'no' ? 'no active' : 'no'}
                  type="button"
                  onClick={() => {
                    setExpandedMarketId(selectedMarket.id)
                    setSelectedOutcome('no')
                    setSelectedOrderBookPlatform('combined')
                  }}
                >
                  No {formatCents(selectedMarket.noPrice)}
                </button>
              </div>

              <div className="amount-row">
                <div>
                  <span>Amount</span>
                </div>
                <label className="amount-input">
                  <span>$</span>
                  <input
                    inputMode="decimal"
                    min="0"
                    type="text"
                    value={formatAmountInput(amount)}
                    onChange={(event) => setAmount(parseAmountInput(event.target.value))}
                    placeholder="0"
                  />
                </label>
              </div>

              <div className="quick-amounts">
                <button type="button" onClick={() => addAmount(1)}>+$1</button>
                <button type="button" onClick={() => addAmount(5)}>+$5</button>
                <button type="button" onClick={() => addAmount(10)}>+$10</button>
                <button type="button" onClick={() => addAmount(100)}>+$100</button>
              </div>

              <button
                className="buy-button"
                disabled={buyStatus === 'signing' || !quote}
                type="button"
                onClick={buyPolymarketOrder}
              >
                {buyStatus === 'signing' ? 'Signing...' : `Buy ${selectedOutcome === 'yes' ? 'Yes' : 'No'}`}
              </button>
              {buyStatus !== 'idle' && (
                <p className={buyStatus === 'error' ? 'bridge-status error' : 'bridge-status'}>
                  {buyStatus === 'signing' && <span className="approval-spinner" />}
                  {buyStatus === 'submitted' && <span className="deposit-success-dot" />}
                  {buyStatus === 'error' ? buyError : buyStatus === 'submitted' ? 'Order submitted' : 'Sign order in wallet'}
                </p>
              )}
              {quote && (
                <div className="quote-info">
                  <div className="quote-routes">
                    <div
                      className="quote-chart"
                      style={{ background: routeChart(getQuoteRoutes(quote)) }}
                    />
                    <div className="quote-route-list">
                      {getQuoteRoutes(quote).map((route) => (
                        <span key={route.platform}>
                          <i style={{ background: routeColor(route.platform) }} />
                          {platformLabel(route.platform)} {formatUsd(route.cost)} {route.percent.toFixed(1)}%
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span>Shares</span>
                    <strong>{quote.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
                  </div>
                  <div>
                    <span>If wins</span>
                    <strong>{formatUsd(quote.payoutIfWin)}</strong>
                  </div>
                  <div>
                    <span>Profit</span>
                    <strong>{formatUsd(quote.profitIfWin)}</strong>
                  </div>
                </div>
              )}
            </aside>
          </section>
        ) : events.length > 0 && (
          <div className="markets-grid">
            {events.map((event) => {
              const markets = ([...(event.markets ?? [])] as Market[]).slice(0, 2)

              return (
                <article
                  className="market-card"
                  key={event.id}
                  onClick={() => {
                    window.history.pushState(null, '', `/${event.slug}`)
                    setSelectedEvent(event)
                    setSelectedMarketId(markets[0]?.id ?? '')
                    setExpandedMarketId('')
                    setSelectedOutcome('yes')
                    setSelectedOrderBookPlatform('combined')
                  }}
                >
                  <div className="market-head">
                    <img src={event.image ?? ''} alt="" />
                    <h2>{event.title?.trim()}</h2>
                  </div>

                  <div className="market-outcomes">
                    {markets.map((market) => {
                      return (
                        <div className="market-body" key={market.id}>
                          <span>{market.title}</span>
                          <strong>{formatPercent(market.yesPrice)}</strong>
                          <button type="button" className="yes">Yes</button>
                          <button type="button" className="no">No</button>
                        </div>
                      )
                    })}
                  </div>

                  <footer className="market-footer">
                    <span>{formatVolume(event.volume)}</span>
                    <div className="market-actions">
                      <button type="button" aria-label="Rewards">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 10h16v10H4V10Zm2-4c0-1.1.9-2 2-2 2 0 4 4 4 4s2-4 4-4c1.1 0 2 .9 2 2s-.9 2-2 2H8c-1.1 0-2-.9-2-2Zm6 2v12m-8-10h16" />
                        </svg>
                      </button>
                      <button type="button" aria-label="Save">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 4h12v16l-6-4-6 4V4Z" />
                        </svg>
                      </button>
                    </div>
                  </footer>
                </article>
              )
            })}

            {placeholderCards.map((card) => (
              <article className="market-card placeholder-card" key={card}>
                <div className="market-head">
                  <div className="placeholder-image" />
                  <h2>Coming soon</h2>
                </div>

                <div className="market-outcomes">
                  <div className="market-body">
                    <span>Outcome A</span>
                    <strong>--</strong>
                    <button type="button" className="yes">Yes</button>
                    <button type="button" className="no">No</button>
                  </div>
                  <div className="market-body">
                    <span>Outcome B</span>
                    <strong>--</strong>
                    <button type="button" className="yes">Yes</button>
                    <button type="button" className="no">No</button>
                  </div>
                </div>

                <footer className="market-footer">
                  <span>-- Vol.</span>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      {approvalsOpen && walletAddress && (
        <div className="modal-backdrop">
          <div className="approvals-modal">
            <div className="approvals-head">
              <div>
                <span>Wallet approvals</span>
                <strong>{shortenAddress(walletAddress)}</strong>
              </div>
              <div className="approval-header-actions">
                <button type="button" onClick={approveAll}>Approve All</button>
                <button type="button" onClick={deapproveAll}>Deapprove All</button>
              </div>
              <button className="approvals-close" type="button" onClick={() => setApprovalsOpen(false)}>×</button>
            </div>

            {approvalsLoading && <p className="approvals-state">Checking approvals...</p>}
            {approvalsError && <p className="approvals-state error">{approvalsError}</p>}
            {!approvalsLoading && approvals && (
              <details className="approval-signing-details">
                <summary>Show details</summary>
                <div className="approvals-list">
                  {approvals.platforms.map((platform) => (
                    <div className="approval-platform" key={platform.platform}>
                      <div className="approval-platform-head">
                        <strong>{approvalPlatformLabel(platform.platform)}</strong>
                        <span className={platform.ready ? 'approval-status ok' : 'approval-status missing'}>
                          {platform.ready ? 'Ready' : 'Missing'}
                        </span>
                      </div>

                      {platform.approvals.map((approval) => (
                        <div className="approval-row" key={approval.id}>
                          <span className={approval.approved ? 'approval-dot ok' : 'approval-dot missing'} />
                          <div>
                            <strong>{approval.id}</strong>
                            <span>
                              {approval.chain ? `${approval.chain} · ` : ''}
                              {approval.type} · {shortenAddress(approval.token)}
                            </span>
                          </div>
                          <span className={approval.approved ? 'approval-status ok' : 'approval-status missing'}>
                            {approval.approved ? 'true' : 'false'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {approveTxStatus && (
              <p className="approvals-state">
                {approveTxPending && <span className="approval-spinner" />}
                {approveTxStatus}
              </p>
            )}
          </div>
        </div>
      )}

      {bridgeOpen && (
        <div className="modal-backdrop">
          <div className="bridge-modal">
            <button className="approvals-close" type="button" onClick={() => setBridgeOpen(false)}>×</button>
            <strong>{bridgeMode === 'bnb' ? 'Bridge BNB' : 'Bridge tokens'}</strong>
            <label className="bridge-input">
              <span>Amount</span>
              <input
                inputMode="decimal"
                placeholder="2"
                type="text"
                value={bridgeAmount}
                onChange={(event) => setBridgeAmount(parseAmountInput(event.target.value))}
              />
            </label>
            <span>{bridgeMode === 'bnb' ? 'Ethereum USDC to BNB USDT' : 'Half to Polygon pUSD, half to BNB USDT'}</span>
            <button
              className="deposit-button"
              disabled={bridgeStatus === 'waiting'}
              type="button"
              onClick={runBridgeTokens}
            >
              Bridge
            </button>
            {bridgeStatus !== 'idle' && (
              <p className={bridgeStatus === 'error' ? 'bridge-status error' : 'bridge-status'}>
                {bridgeStatus === 'waiting' && <span className="approval-spinner" />}
                {bridgeStatus === 'success' && <span className="deposit-success-dot" />}
                {bridgeStatus === 'error' ? bridgeError : 'Waiting destination balances...'}
              </p>
            )}
          </div>
        </div>
      )}

      {returnDepositOpen && (
        <div className="modal-backdrop">
          <div className="bridge-modal">
            <button className="approvals-close" type="button" onClick={() => setReturnDepositOpen(false)}>×</button>
            <strong>Return deposit</strong>
            <span>BNB USDT to Ethereum USDC</span>
            <span>Polygon pUSD to Ethereum USDC</span>
            <button
              className="deposit-button"
              disabled={returnDepositStatus === 'waiting'}
              type="button"
              onClick={runReturnDeposit}
            >
              Return to ETH
            </button>
            {returnDepositStatus !== 'idle' && (
              <p className={returnDepositStatus === 'error' ? 'bridge-status error' : 'bridge-status'}>
                {returnDepositStatus === 'waiting' && <span className="approval-spinner" />}
                {returnDepositStatus === 'success' && <span className="deposit-success-dot" />}
                {returnDepositStatus === 'error'
                  ? returnDepositError
                  : returnDepositStatus === 'success'
                    ? 'Returned to Ethereum USDC'
                    : 'Waiting Ethereum USDC balance...'}
              </p>
            )}
          </div>
        </div>
      )}

      {depositWaitingOpen && (
        <div className="modal-backdrop">
          <div className="deposit-modal">
            <button className="approvals-close" type="button" onClick={() => setDepositWaitingOpen(false)}>×</button>
            {depositStatus === 'waiting' ? <span className="approval-spinner" /> : <span className="deposit-success-dot" />}
            <strong>Waiting deposit...</strong>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
