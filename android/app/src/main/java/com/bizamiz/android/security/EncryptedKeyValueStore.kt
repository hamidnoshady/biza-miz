package com.bizamiz.android.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.bizamiz.android.callerid.CallerIdCache
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Authenticated AES-256-GCM at-rest key-value store for sensitive native caches
 * such as CRM Caller ID (issue #884, Root Cause 6).
 *
 * Security invariants:
 * - Every value is encrypted with a fresh 96-bit random IV using AES/GCM/NoPadding
 *   and a 128-bit authentication tag before touching `BackingStore`.
 * - The entry key is bound as GCM Additional Authenticated Data (AAD), preventing
 *   ciphertext substitution across keys or tenants (`tenant_callers:biz-A` vs `biz-B`).
 * - `clearAll()` performs both storage deletion and cryptographic erasure by
 *   deleting/rotating the wrapping `SecretKey` in `SecretKeyProvider`.
 * - Uses a pure-Kotlin RFC 4648 Base64 codec so it runs identically on Android
 *   API 24+ (without `java.util.Base64` Lint `NewApi` violations) and in pure
 *   JVM unit tests (without `android.util.Base64` stubs).
 */
class EncryptedKeyValueStore(
    private val backingStore: BackingStore,
    private val keyProvider: SecretKeyProvider,
    private val secureRandom: SecureRandom = SecureRandom(),
) : CallerIdCache.KeyValueStore {

    interface BackingStore {
        fun getRaw(key: String): String?
        fun putRaw(key: String, ciphertextPayload: String)
        fun removeRaw(key: String)
        fun clearRaw()
    }

    interface SecretKeyProvider {
        fun getOrCreateKey(): SecretKey
        fun rotateOrDeleteKey()
    }

    override fun getString(key: String): String? {
        val raw = backingStore.getRaw(key) ?: return null
        if (!raw.startsWith(VERSION_PREFIX)) {
            backingStore.removeRaw(key)
            return null
        }
        val parts = raw.removePrefix(VERSION_PREFIX).split(':', limit = 2)
        if (parts.size != 2) {
            backingStore.removeRaw(key)
            return null
        }
        return try {
            val iv = decodeBase64(parts[0])
            val ciphertext = decodeBase64(parts[1])
            if (iv.size != GCM_IV_LENGTH_BYTES || ciphertext.isEmpty()) {
                backingStore.removeRaw(key)
                return null
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                keyProvider.getOrCreateKey(),
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv),
            )
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            val plaintextBytes = cipher.doFinal(ciphertext)
            String(plaintextBytes, Charsets.UTF_8)
        } catch (_: Exception) {
            // Authentication failure, key rotation, or corrupted entry: fail closed and evict.
            backingStore.removeRaw(key)
            null
        }
    }

    override fun putString(key: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val secretKey = keyProvider.getOrCreateKey()
        // AndroidKeyStore keys enforce randomized IV generation by default; for software
        // JVM keys we supply a fresh 96-bit IV explicitly when the provider does not.
        val iv: ByteArray = try {
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            cipher.iv ?: ByteArray(GCM_IV_LENGTH_BYTES).also {
                secureRandom.nextBytes(it)
                cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, it))
            }
        } catch (_: Exception) {
            ByteArray(GCM_IV_LENGTH_BYTES).also {
                secureRandom.nextBytes(it)
                cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, it))
            }
        }
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val encoded = "$VERSION_PREFIX${encodeBase64(iv)}:${encodeBase64(ciphertext)}"
        backingStore.putRaw(key, encoded)
    }

    override fun remove(key: String) {
        backingStore.removeRaw(key)
    }

    override fun clearAll() {
        backingStore.clearRaw()
        keyProvider.rotateOrDeleteKey()
    }

    /**
     * Android Keystore-backed AES-256-GCM key provider.
     * Deleting the alias on `rotateOrDeleteKey()` cryptographically invalidates any
     * residual ciphertext on flash storage.
     */
    class AndroidKeystoreSecretKeyProvider(
        private val keyAlias: String = DEFAULT_KEY_ALIAS,
    ) : SecretKeyProvider {
        @Synchronized
        override fun getOrCreateKey(): SecretKey {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val existing = keyStore.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry
            if (existing != null) {
                return existing.secretKey
            }
            val keyGenerator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE,
            )
            val spec = KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
            keyGenerator.init(spec)
            return keyGenerator.generateKey()
        }

        @Synchronized
        override fun rotateOrDeleteKey() {
            try {
                val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                if (keyStore.containsAlias(keyAlias)) {
                    keyStore.deleteEntry(keyAlias)
                }
            } catch (_: Exception) {
                // Ignore if KeyStore alias was already absent.
            }
        }
    }

    /**
     * In-memory AES-256 key provider for pure JVM unit tests where AndroidKeyStore
     * hardware/HAL is not present.
     */
    class JvmSecretKeyProvider : SecretKeyProvider {
        @Volatile
        private var currentKey: SecretKey? = null

        @Synchronized
        override fun getOrCreateKey(): SecretKey {
            currentKey?.let { return it }
            val generator = KeyGenerator.getInstance("AES")
            generator.init(256)
            return generator.generateKey().also { currentKey = it }
        }

        @Synchronized
        override fun rotateOrDeleteKey() {
            currentKey = null
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_KEY_ALIAS = "biza_caller_id_aes_gcm_v1"
        private const val ENCRYPTED_PREFS_NAME = "biza_caller_id_encrypted_v1"
        private const val LEGACY_PLAIN_PREFS_NAME = "biza_caller_id_cache"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_LENGTH_BYTES = 12
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val VERSION_PREFIX = "v1:"

        private const val BASE64_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        fun fromContext(context: Context): EncryptedKeyValueStore {
            val appContext = context.applicationContext
            // Purge any legacy unencrypted SharedPreferences file on upgrade.
            val legacyPrefs = appContext.getSharedPreferences(LEGACY_PLAIN_PREFS_NAME, Context.MODE_PRIVATE)
            if (legacyPrefs.all.isNotEmpty()) {
                legacyPrefs.edit().clear().commit()
            }

            val prefs = appContext.getSharedPreferences(ENCRYPTED_PREFS_NAME, Context.MODE_PRIVATE)
            val backing = object : BackingStore {
                override fun getRaw(key: String): String? = prefs.getString(key, null)
                override fun putRaw(key: String, ciphertextPayload: String) {
                    prefs.edit().putString(key, ciphertextPayload).commit()
                }
                override fun removeRaw(key: String) {
                    prefs.edit().remove(key).commit()
                }
                override fun clearRaw() {
                    prefs.edit().clear().commit()
                }
            }
            return EncryptedKeyValueStore(
                backingStore = backing,
                keyProvider = AndroidKeystoreSecretKeyProvider(),
            )
        }

        internal fun encodeBase64(data: ByteArray): String {
            if (data.isEmpty()) return ""
            val out = StringBuilder(((data.size + 2) / 3) * 4)
            var i = 0
            while (i < data.size) {
                val b0 = data[i].toInt() and 0xFF
                val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xFF else 0
                val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xFF else 0
                val triple = (b0 shl 16) or (b1 shl 8) or b2

                out.append(BASE64_ALPHABET[(triple ushr 18) and 0x3F])
                out.append(BASE64_ALPHABET[(triple ushr 12) and 0x3F])
                out.append(if (i + 1 < data.size) BASE64_ALPHABET[(triple ushr 6) and 0x3F] else '=')
                out.append(if (i + 2 < data.size) BASE64_ALPHABET[triple and 0x3F] else '=')
                i += 3
            }
            return out.toString()
        }

        internal fun decodeBase64(encoded: String): ByteArray {
            val clean = encoded.trim()
            if (clean.isEmpty() || clean.length % 4 != 0) return ByteArray(0)
            val pad = when {
                clean.endsWith("==") -> 2
                clean.endsWith("=") -> 1
                else -> 0
            }
            val outSize = (clean.length / 4) * 3 - pad
            val out = ByteArray(outSize)
            var outIdx = 0
            var i = 0
            while (i < clean.length) {
                val c0 = base64Value(clean[i])
                val c1 = base64Value(clean[i + 1])
                val c2 = if (clean[i + 2] == '=') 0 else base64Value(clean[i + 2])
                val c3 = if (clean[i + 3] == '=') 0 else base64Value(clean[i + 3])
                if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return ByteArray(0)

                val triple = (c0 shl 18) or (c1 shl 12) or (c2 shl 6) or c3
                if (outIdx < outSize) out[outIdx++] = ((triple ushr 16) and 0xFF).toByte()
                if (outIdx < outSize) out[outIdx++] = ((triple ushr 8) and 0xFF).toByte()
                if (outIdx < outSize) out[outIdx++] = (triple and 0xFF).toByte()
                i += 4
            }
            return out
        }

        private fun base64Value(ch: Char): Int = when (ch) {
            in 'A'..'Z' -> ch.code - 'A'.code
            in 'a'..'z' -> ch.code - 'a'.code + 26
            in '0'..'9' -> ch.code - '0'.code + 52
            '+' -> 62
            '/' -> 63
            else -> -1
        }
    }
}
