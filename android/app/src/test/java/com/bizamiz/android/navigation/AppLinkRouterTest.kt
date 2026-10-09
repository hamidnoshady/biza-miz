package com.bizamiz.android.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

class AppLinkRouterTest {

    private val origin = "https://app.example.test"
    private val home = "https://app.example.test/"

    @Test
    fun launcherIconOpensHome() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide(null, origin))
    }

    @Test
    fun originWithTrailingSlashIsAccepted() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide(null, "https://app.example.test/"))
    }

    @Test
    fun emptyOriginIsNotConfigured() {
        assertEquals(LaunchDecision.NotConfigured, AppLinkRouter.decide(null, ""))
        assertEquals(LaunchDecision.NotConfigured, AppLinkRouter.decide("https://app.example.test/x", " "))
    }

    @Test
    fun originThatIsNotBareHttpsIsNotConfigured() {
        for (bad in listOf(
            "http://app.example.test",
            "https://app.example.test/app",
            "https://app.example.test?x=1",
            "https://user@app.example.test",
            "https://app.example.test:8443",
            "https://APP_EXAMPLE.test",
            "not a url",
        )) {
            assertEquals(bad, LaunchDecision.NotConfigured, AppLinkRouter.decide(null, bad))
        }
    }

    @Test
    fun appLinkOnTheSameHostOpensThatPath() {
        val link = "https://app.example.test/crm/leads?stage=new"
        assertEquals(LaunchDecision.Open(link), AppLinkRouter.decide(link, origin))
    }

    @Test
    fun hostComparisonIgnoresCase() {
        val link = "https://APP.example.test/accounting"
        assertEquals(LaunchDecision.Open(link), AppLinkRouter.decide(link, origin))
    }

    @Test
    fun foreignHostFallsBackToHome() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide("https://evil.example/login", origin))
    }

    @Test
    fun lookalikeHostsFallBackToHome() {
        for (link in listOf(
            "https://app.example.test.evil.example/",
            "https://app.example.test@evil.example/",
            "https://evil.example/app.example.test",
        )) {
            assertEquals(link, LaunchDecision.Open(home), AppLinkRouter.decide(link, origin))
        }
    }

    @Test
    fun plainHttpFallsBackToHome() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide("http://app.example.test/x", origin))
    }

    @Test
    fun nonStandardPortFallsBackToHome() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide("https://app.example.test:8443/x", origin))
    }

    @Test
    fun explicitDefaultPortIsAccepted() {
        val link = "https://app.example.test:443/x"
        assertEquals(LaunchDecision.Open(link), AppLinkRouter.decide(link, origin))
    }

    @Test
    fun malformedLinkFallsBackToHome() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide("https://app example/ bad", origin))
    }

    @Test
    fun blankLinkIsTreatedAsTheLauncher() {
        assertEquals(LaunchDecision.Open(home), AppLinkRouter.decide("   ", origin))
    }
}
