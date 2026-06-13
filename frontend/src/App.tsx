import { useEffect, useRef, useState } from 'react'
import { DynamicWidget } from '@dynamic-labs/sdk-react-core'
import { Polymarket, type Event, type Market } from 'polymarket-data'
import eventIds from './eventIds.json'
import './App.css'

const polymarket = new Polymarket()

type Order = {
  price: string
  size: string
}

type OrderBook = {
  asks: Order[]
  bids: Order[]
}

type OutcomeSide = 'yes' | 'no'

function parseJsonList(value?: string | null) {
  if (!value) return []

  try {
    return JSON.parse(value) as string[]
  } catch {
    return []
  }
}

function asText(value: unknown) {
  return typeof value === 'string' ? value : ''
}

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

function getEventSlugFromPath() {
  return window.location.pathname.replace(/^\/+/, '')
}

function App() {
  const orderBookTableRef = useRef<HTMLDivElement | null>(null)
  const spreadRowRef = useRef<HTMLDivElement | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [expandedMarketId, setExpandedMarketId] = useState('')
  const [selectedOutcome, setSelectedOutcome] = useState<OutcomeSide>('yes')
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null)
  const [orderBookLoading, setOrderBookLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function loadEvents() {
      try {
        const loadedEvents = await Promise.all(eventIds.map((eventId) => polymarket.gamma.events.getEventById(eventId)))
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
    }

    window.addEventListener('popstate', syncEventFromUrl)
    return () => window.removeEventListener('popstate', syncEventFromUrl)
  }, [events])

  const placeholderCards = Array.from(
    { length: Math.max(0, 9 - events.length) },
    (_, index) => index + 1,
  )
  const selectedMarkets = ([...(selectedEvent?.markets ?? [])] as Market[]).sort((a, b) => {
    const aYes = Number(parseJsonList(asText(a.outcomePrices))[0] ?? 0)
    const bYes = Number(parseJsonList(asText(b.outcomePrices))[0] ?? 0)
    return bYes - aYes
  })
  const selectedMarket = selectedMarkets.find((market) => market.id === selectedMarketId) ?? selectedMarkets[0]
  const expandedMarket = selectedMarkets.find((market) => market.id === expandedMarketId)
  const selectedPrices = parseJsonList(asText(selectedMarket?.outcomePrices))
  const asks = [...(orderBook?.asks ?? [])].sort((a, b) => Number(b.price) - Number(a.price))
  const bids = [...(orderBook?.bids ?? [])].sort((a, b) => Number(b.price) - Number(a.price))

  useEffect(() => {
    async function loadOrderBook() {
      const tokenIds = parseJsonList(asText(expandedMarket?.clobTokenIds))
      const tokenId = selectedOutcome === 'yes' ? tokenIds[0] : tokenIds[1]

      if (!tokenId) {
        setOrderBook(null)
        return
      }

      setOrderBookLoading(true)

      try {
        const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`)
        setOrderBook(await response.json() as OrderBook)
      } catch {
        setOrderBook(null)
      } finally {
        setOrderBookLoading(false)
      }
    }

    loadOrderBook()
  }, [expandedMarket?.clobTokenIds, selectedOutcome])

  useEffect(() => {
    if (!orderBook || orderBookLoading) return

    requestAnimationFrame(() => {
      const table = orderBookTableRef.current
      const spread = spreadRowRef.current

      if (!table || !spread) return

      table.scrollTop = spread.offsetTop - table.offsetTop - table.clientHeight / 2
    })
  }, [orderBook, orderBookLoading, selectedMarketId])

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
                <img src={selectedEvent.image ?? selectedEvent.icon ?? ''} alt="" />
                <h2>{selectedEvent.title?.trim()}</h2>
              </div>

              <div className="detail-list">
                {selectedMarkets.map((market) => {
                  const prices = parseJsonList(asText(market.outcomePrices))
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
                        }}
                      >
                        <img src={market.image ?? market.icon ?? selectedEvent.image ?? ''} alt="" />
                        <div className="detail-title">
                          <strong>{market.groupItemTitle ?? market.question}</strong>
                          <span>{formatVolume(market.volumeNum ?? market.volume)}</span>
                        </div>
                        <strong className="detail-price">{formatPercent(prices[0])}</strong>
                        <span className="detail-change">▲ 1%</span>
                        <button
                          className={isExpanded && selectedOutcome === 'yes' ? 'detail-buy yes active' : 'detail-buy yes'}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedMarketId(market.id)
                            setExpandedMarketId(market.id)
                            setSelectedOutcome('yes')
                          }}
                        >
                          Buy Yes {formatCents(prices[0])}
                        </button>
                        <button
                          className={isExpanded && selectedOutcome === 'no' ? 'detail-buy no active' : 'detail-buy no'}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedMarketId(market.id)
                            setExpandedMarketId(market.id)
                            setSelectedOutcome('no')
                          }}
                        >
                          Buy No {formatCents(prices[1])}
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="orderbook">
                          <div className="orderbook-tabs">
                            <strong>Order Book</strong>
                          </div>

                          <div className="orderbook-table" ref={orderBookTableRef}>
                            <div className="orderbook-header">
                              <span>Trade {selectedOutcome === 'yes' ? 'Yes' : 'No'}</span>
                              <span>Price</span>
                              <span>Shares</span>
                              <span>Total</span>
                            </div>

                            {orderBookLoading && <p className="orderbook-state">Loading order book...</p>}

                            {!orderBookLoading && (
                              <>
                                <div className="orderbook-side asks">
                                  <span className="side-label">Asks</span>
                                  {asks.map((order) => (
                                    <div className="order-row" key={`ask-${order.price}-${order.size}`}>
                                      <span></span>
                                      <strong>{formatCents(order.price)}</strong>
                                      <span>{formatShares(order.size)}</span>
                                      <span>{formatTotal(order)}</span>
                                    </div>
                                  ))}
                                </div>

                                <div className="spread-row" ref={spreadRowRef}>
                                  <span>Last: {formatCents(selectedOutcome === 'yes' ? prices[0] : prices[1])}</span>
                                  <span>Spread: 0.1c</span>
                                </div>

                                <div className="orderbook-side bids">
                                  <span className="side-label">Bids</span>
                                  {bids.map((order) => (
                                    <div className="order-row" key={`bid-${order.price}-${order.size}`}>
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
                <img src={selectedMarket.image ?? selectedMarket.icon ?? selectedEvent.image ?? ''} alt="" />
                <div>
                  <span>{selectedEvent.title?.trim()}</span>
                  <strong>{selectedMarket.groupItemTitle ?? selectedMarket.question}</strong>
                </div>
              </div>

              <div className="bet-tabs">
                <button className="active" type="button">Buy</button>
                <button type="button">Sell</button>
                <span>Market⌄</span>
              </div>

              <div className="bet-outcomes">
                <button
                  className={selectedOutcome === 'yes' ? 'yes active' : 'yes'}
                  type="button"
                  onClick={() => {
                    setExpandedMarketId(selectedMarket.id)
                    setSelectedOutcome('yes')
                  }}
                >
                  Yes {formatCents(selectedPrices[0])}
                </button>
                <button
                  className={selectedOutcome === 'no' ? 'no active' : 'no'}
                  type="button"
                  onClick={() => {
                    setExpandedMarketId(selectedMarket.id)
                    setSelectedOutcome('no')
                  }}
                >
                  No {formatCents(selectedPrices[1])}
                </button>
              </div>

              <div className="amount-row">
                <div>
                  <span>Amount</span>
                  <small>$34.84 cash</small>
                </div>
                <strong>$0</strong>
              </div>

              <div className="quick-amounts">
                <button type="button">+$1</button>
                <button type="button">+$5</button>
                <button type="button">+$10</button>
                <button type="button">+$100</button>
              </div>

              <button className="buy-button" type="button">Buy {selectedOutcome === 'yes' ? 'Yes' : 'No'}</button>
              <p>By trading, you agree to the Terms of Use.</p>
            </aside>
          </section>
        ) : events.length > 0 && (
          <div className="markets-grid">
            {events.map((event) => {
              const markets = ([...(event.markets ?? [])] as Market[]).sort((a, b) => {
                const aYes = Number(parseJsonList(asText(a.outcomePrices))[0] ?? 0)
                const bYes = Number(parseJsonList(asText(b.outcomePrices))[0] ?? 0)
                return bYes - aYes
              }).slice(0, 2)

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
                  }}
                >
                  <div className="market-head">
                    <img src={event.image ?? event.icon ?? ''} alt="" />
                    <h2>{event.title?.trim()}</h2>
                  </div>

                  <div className="market-outcomes">
                    {markets.map((market) => {
                      const prices = parseJsonList(asText(market.outcomePrices))

                      return (
                        <div className="market-body" key={market.id}>
                          <span>{market.groupItemTitle ?? market.question}</span>
                          <strong>{formatPercent(prices[0])}</strong>
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
