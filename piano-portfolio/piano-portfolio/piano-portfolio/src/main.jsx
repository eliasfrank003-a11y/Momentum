import React from ‘react’
import ReactDOM from ‘react-dom/client’
import App from ‘./App.jsx’
import ‘./index.css’ // Optional if you use a separate css file, but tailwind script covers mostly

ReactDOM.createRoot(document.getElementById(‘root’)).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
