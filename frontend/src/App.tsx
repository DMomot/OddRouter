import { useEffect, useRef, useState } from 'react'
import { DynamicWidget } from '@dynamic-labs/sdk-react-core'
import eventSlugs from './eventIds.json'
import './App.css'

const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

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
    cost: number
  }>
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

function getEventSlugFromPath() {
  return window.location.pathname.replace(/^\/+/, '')
}

async function fetchApi<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`)

  if (!response.ok) throw new Error(await response.text())

  return response.json() as Promise<T>
}

function App() {
  const orderBookTableRef = useRef<HTMLDivElement | null>(null)
  const spreadRowRef = useRef<HTMLDivElement | null>(null)
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

  const placeholderCards = Array.from(
    { length: Math.max(0, 9 - events.length) },
    (_, index) => index + 1,
  )
  const selectedMarkets = [...(selectedEvent?.markets ?? [])] as Market[]
  const selectedMarket = selectedMarkets.find((market) => market.id === selectedMarketId) ?? selectedMarkets[0]
  const expandedMarket = selectedMarkets.find((market) => market.id === expandedMarketId)
  const asks = orderBook?.asks ?? []
  const bids = orderBook?.bids ?? []

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

  return (
    <main className="app">
      <header className="header">
        <div className="header-left">
          <div className="brand">
            <span className="brand-mark">O</span>
            <span>OddRouter</span>
          </div>
        </div>

        <div className="header-actions">
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

              <button className="buy-button" type="button">Buy {selectedOutcome === 'yes' ? 'Yes' : 'No'}</button>
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
    </main>
  )
}

export default App
