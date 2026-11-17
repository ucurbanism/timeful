// Cookie consent utilities
export const COOKIE_CONSENT_KEY = "cookieConsent"

export function getCookieConsent() {
  try {
    const consent = localStorage.getItem(COOKIE_CONSENT_KEY)
    if (!consent) return null

    return JSON.parse(consent)
  } catch (error) {
    console.error("Error parsing cookie consent:", error)
    return null
  }
}

export function setCookieConsent(preferences) {
  const consentData = {
    timestamp: new Date().toISOString(),
    preferences: {
      necessary: true, // Always true
      analytics: Boolean(preferences.analytics),
      advertising: Boolean(preferences.advertising),
    },
  }

  localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(consentData))
  return consentData
}

export function hasAnalyticsConsent() {
  const consent = getCookieConsent()
  return consent?.preferences?.analytics === true
}

export function hasAdvertisingConsent() {
  const consent = getCookieConsent()
  return consent?.preferences?.advertising === true
}

export function hasGivenConsent() {
  return getCookieConsent() !== null
}

