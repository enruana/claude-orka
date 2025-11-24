import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskbarApp } from './TaskbarApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TaskbarApp />
  </StrictMode>
)
