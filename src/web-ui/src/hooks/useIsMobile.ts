import { useState, useEffect } from 'react'

/** Detect mobile/tablet via screen width and pointer type */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return (
      window.matchMedia('(max-width: 1024px)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    )
  })

  useEffect(() => {
    const widthQuery = window.matchMedia('(max-width: 1024px)')
    const touchQuery = window.matchMedia('(pointer: coarse)')

    const checkMobile = () => {
      setIsMobile(widthQuery.matches || touchQuery.matches)
    }

    widthQuery.addEventListener('change', checkMobile)
    touchQuery.addEventListener('change', checkMobile)
    window.addEventListener('resize', checkMobile)
    checkMobile()

    return () => {
      widthQuery.removeEventListener('change', checkMobile)
      touchQuery.removeEventListener('change', checkMobile)
      window.removeEventListener('resize', checkMobile)
    }
  }, [])

  return isMobile
}
