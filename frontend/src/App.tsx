import { DynamicWidget } from '@dynamic-labs/sdk-react-core'
import './App.css'

function App() {
  return (
    <main className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">O</span>
          <span>OddRouter</span>
        </div>
        <div className="wallet">
          <DynamicWidget />
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">Prediction markets aggregator</p>
        <h1>All prediction markets in one place.</h1>
        <p className="placeholder">
          Placeholder: discover markets, compare odds, and route trades across
          the best prediction market venues.
        </p>
      </section>
    </main>
  )
}

export default App
