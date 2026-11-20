package com.bizamiz.android.updates

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The release feed holds all three products' builds. Only a stable Android
 * release carrying an APK, newer than the installed version, may be offered.
 */
class UpdateReleasePolicyTest {

    private fun release(
        tag: String,
        assetName: String? = "bizamiz-android-${tag.removePrefix("android-v")}.apk",
        draft: Boolean = false,
        prerelease: Boolean = false,
    ): org.json.JSONObject {
        val assets = JSONArray()
        if (assetName != null) {
            assets.put(
                org.json.JSONObject()
                    .put("name", assetName)
                    .put("browser_download_url", "https://github.com/hamidnoshady/biza-miz/releases/download/$tag/$assetName"),
            )
        }
        return org.json.JSONObject()
            .put("tag_name", tag)
            .put("draft", draft)
            .put("prerelease", prerelease)
            .put("body", "notes for $tag")
            .put("html_url", "https://github.com/hamidnoshady/biza-miz/releases/tag/$tag")
            .put("assets", assets)
    }

    private fun feed(vararg releases: org.json.JSONObject): JSONArray {
        val array = JSONArray()
        releases.forEach { array.put(it) }
        return array
    }

    @Test
    fun `picks the newest Android release newer than the installed build`() {
        val picked = UpdateReleasePolicy.newestAvailable(
            feed(release("android-v1.2.0"), release("android-v1.3.1"), release("android-v1.3.0")),
            "1.2.4",
        )
        assertEquals("1.3.1", picked?.version)
        assertTrue(picked?.apkUrl?.endsWith("bizamiz-android-1.3.1.apk") == true)
        assertEquals("notes for android-v1.3.1", picked?.notes)
    }

    @Test
    fun `ignores desktop and WordPress plugin releases in the same repository`() {
        val picked = UpdateReleasePolicy.newestAvailable(
            feed(release("desktop-v9.9.9"), release("v9.9.9", assetName = "pos-accounting-connector.zip"), release("android-v1.1.0")),
            "1.0.0",
        )
        assertEquals("1.1.0", picked?.version)
    }

    @Test
    fun `ignores drafts, prereleases and releases without an APK asset`() {
        val picked = UpdateReleasePolicy.newestAvailable(
            feed(
                release("android-v2.0.0", draft = true),
                release("android-v2.1.0", prerelease = true),
                release("android-v2.2.0", assetName = null),
                release("android-v2.3.0", assetName = "notes.txt"),
                release("android-v1.1.0"),
            ),
            "1.0.0",
        )
        assertEquals("1.1.0", picked?.version)
    }

    @Test
    fun `offers nothing when the installed build is current or ahead`() {
        val installed = feed(release("android-v1.0.0"), release("android-v0.9.0"))
        assertNull(UpdateReleasePolicy.newestAvailable(installed, "1.0.0"))
        assertNull(UpdateReleasePolicy.newestAvailable(installed, "1.4.0"))
    }

    @Test
    fun `version comparison is numeric, not string based`() {
        assertTrue(UpdateReleasePolicy.isNewer("1.10.0", "1.9.9"))
        assertFalse(UpdateReleasePolicy.isNewer("1.9.9", "1.10.0"))
        assertFalse(UpdateReleasePolicy.isNewer("1.0.0", "1.0.0"))
        assertFalse(UpdateReleasePolicy.isNewer("not-a-version", "1.0.0"))
        assertEquals(listOf(1, 2, 3), UpdateReleasePolicy.parseVersion("android-v1.2.3"))
        assertNull(UpdateReleasePolicy.parseVersion("android-v1.2"))
    }
}
