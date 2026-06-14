import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DynamicContextProvider, overrideNetworkRpcUrl } from '@dynamic-labs/sdk-react-core'
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum'
import './index.css'
import App from './App.tsx'

const dynamicEnvironmentId = (
  import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID
  ?? import.meta.env.DYNAMIC_ENVIRONMENT_ID
  ?? import.meta.env.DYNAMIC_ENVIROMENT_ID
  ?? ''
)

const evmRpcOverrides = {
  1: [import.meta.env.VITE_ETH_RPC_URL ?? 'https://rpc.nodeflare.app/eth/public'],
  56: [import.meta.env.VITE_BNB_RPC_URL ?? 'https://bsc.api.pocket.network'],
  137: [import.meta.env.VITE_POLYGON_RPC_URL ?? 'https://polygon.drpc.org'],
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DynamicContextProvider
      settings={{
        environmentId: dynamicEnvironmentId,
        overrides: {
          evmNetworks: (networks) => overrideNetworkRpcUrl(networks, evmRpcOverrides),
        },
        walletConnectors: [EthereumWalletConnectors],
      }}
    >
      <App />
    </DynamicContextProvider>
  </StrictMode>,
)
