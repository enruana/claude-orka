/**
 * API Configuration
 * Handles base URL for API calls, works on both desktop and mobile
 * Uses window.location.origin to automatically work from any access point (VPN, local, etc.)
 */

/**
 * Get the API base URL
 * Uses window.location.origin to get the same host the user is accessing from
 * This works regardless of whether access is via localhost, local IP, VPN, or domain
 */
export function getApiBaseUrl(): string {
  // Use the origin from where the page was loaded
  // This automatically handles VPN, tunnels, different IPs, etc.
  return `${window.location.origin}/api`
}

/**
 * Get the full URL for an API endpoint
 */
export function getFullApiUrl(endpoint: string): string {
  const base = getApiBaseUrl()
  return `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
}

/**
 * Build a fetch request with proper error handling
 */
export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = getFullApiUrl(endpoint)

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(errorText || `HTTP ${res.status}: ${res.statusText}`)
    }

    // Handle empty responses
    const text = await res.text()
    if (!text) {
      return {} as T
    }

    return JSON.parse(text)
  } catch (error: any) {
    // Enhance error message for network errors
    if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
      throw new Error(`Network error: Cannot connect to ${url}`)
    }
    throw error
  }
}

// For backwards compatibility with code using API_BASE directly
export const API_BASE = '/api'
