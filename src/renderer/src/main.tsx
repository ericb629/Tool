import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// ===================== TEMPORARY - RESTORE ME =====================
// StrictMode is DISABLED for the perf isolation run, to separate its cost
// from dev-vs-production React. It double-invokes render bodies and useMemo
// factories on every render, so computePageLayout over all 138 pages, plus
// visibleRange and visibleRegions, each run twice per render pass - and a
// wheel tick produces two render passes.
//
// Restore by deleting this block and reinstating:
//   import React from 'react'
//   ...render(<React.StrictMode><App /></React.StrictMode>)
// ==================================================================
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
