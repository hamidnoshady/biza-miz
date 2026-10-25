# Branding — Bizamiz / بیزامیز

The platform is **Bizamiz** in English and **بیزامیز** in Persian. One name, two
spellings, chosen by the UI language: Persian UI shows the Persian name, English UI
shows the Latin one. It replaced "Biza Miz" (Android, Telegram), "Business Suite"
(Windows desktop), "POS Accounting Connector" (WordPress plugin), "Cafe POS" (print
connector) and «اشوبه» (the panel, the plugin's menu, the print service, the website
builder).

## Where the name lives

| Surface | Source of truth | Language rule |
|---|---|---|
| Web app (tab title, PWA manifest, login pages, passkey prompt, MCP/OAuth metadata, Telegram bot/Mini App, AI assistant prompt) | `src/lib/brand.ts` (`BRAND_NAME_FA`, `BRAND_NAME_EN`, `brandName(locale)`) | The web app is Persian (`lang="fa"`), so pages and the installed PWA use «بیزامیز»; machine-facing English metadata (OAuth `resource_name`, description) uses "Bizamiz". The Telegram bot answers in the user's language. |
| Windows desktop (window title, error dialogs) | `electron/brand.js` (mirror of `brand.ts`, pinned by `src/lib/brand.test.ts`) | `app.getLocale()`: `fa*` → «بیزامیز», otherwise "Bizamiz". |
| Windows installer / shortcuts / executable | `electron/package.json` (`productName`, `nsis.shortcutName`, `nsis.menuCategory`) | File-system names are Latin: `Bizamiz Setup X.Y.Z.exe`, `Bizamiz.exe`, Start-menu folder "Bizamiz". |
| WordPress plugin (Plugins-list name, admin menu, screen headers, WP-CLI) | `pos_connector_brand()` / `pos_connector_plugin_title()` in `pos-accounting-connector.php` | `determine_locale()` starting with `fa` → «بیزامیز» / «اتصال بیزامیز»; otherwise "Bizamiz" / "Bizamiz Connector". The header `Plugin Name` is "Bizamiz Connector". |
| Android (launcher label) | `config/android-environments.json` (English, via `resValue`) + `android/app/src/<flavor>/res/values-fa/strings.xml` | Device language `fa` shows «بیزامیز» (with «(آزمایشی)» / «(توسعه)» on staging / development), everything else "Bizamiz …". |
| Print connector (installer window, Start-menu shortcut, spool document name) | `src/lib/windows-print-connector.ts`, `public/windows/cafe-pos-print-connector.ps1` | English text; "Bizamiz". Release 3.3.1. |

A drift guard, `src/lib/brand-coverage.test.ts`, fails when an old display name returns
in shipped sources. A file that must keep one is listed there with the reason.

## Deliberately NOT renamed (identifiers, not names)

Each of these is keyed on by something already installed, signed or deployed. Changing
it is a migration, not a rename.

| Identifier | Why it stays |
|---|---|
| WordPress plugin folder / slug `pos-accounting-connector`, main file, text domain, `wp pos-connector`, `POS_CONNECTOR_*`, option keys, zip name | WordPress identifies an installed plugin by folder + main file; renaming either orphans every installed copy and breaks its update path. The visible name changes; the slug does not. If a slug rename is ever wanted, the safe path is a bridge release that ships under the new slug and deactivates the old one. |
| `com.businesssuite.desktop` (electron-builder `appId`), the pinned NSIS GUID | The installer's upgrade identity. |
| `businesssuite://` protocol, `BusinessSuiteEmbed/1` user-agent token | Wire contracts between the cloud and already-installed desktops. A rename needs both sides to accept both spellings first. |
| `business-suite.local`, `business-suite-local-ca.crt`, `/__business-suite/…` | The local HTTPS gateway's certificate name and URLs, already trusted on paired phones. The CA's subject ("Business Suite Local CA") is part of that trust. |
| `electron/package.json` `name` (`business-suite-desktop`), CI artifact names | npm / CI plumbing, not shown to users. |
| `com.bizamiz.*` application ids, `bizamiz://` scheme, Kotlin class names | Already Bizamiz-spelled; the Play listing id cannot change after publishing. |
| `BizaMizOfficialBot` (Telegram bot username) | A Telegram handle; renaming it is done in BotFather and changes every t.me link. Needs Hamid. |
| `cafe-restaurant-pos` (npm package name, backup manifest `app`, GitHub repo, `source: "cafe-pos"` key alias metadata) | Backups, restores and the LiteLLM key metadata compare these strings. |
| `public/windows/cafe-pos-print-connector.ps1`, `%LOCALAPPDATA%\CafePOS\PrintConnector`, `CAFE_POS_*` markers | Installed connectors find themselves by path and marker. |
| `eshobe-cms`, `ESHOBE_CMS_*`, `x-eshobe-signature`, `eshobe_cms_connections`, `*.eshobe.com` domains | The external CMS deployment's repo, env contract, webhook header, tables and hosting domains. The CMS manager's *label* is now «سایت‌ساز بیزامیز». |
| `userData` folder (`%APPDATA%\Business Suite` / `business-suite-desktop`) | The desktop pins it explicitly (`electron/user-data-path.js`): an existing install keeps its database; a fresh machine gets `%APPDATA%\Bizamiz`. |
| Windows code-signing publisher | Comes from `WINDOWS_EXPECTED_SIGNER`, never from the product name. |

## Upgrading an existing Windows install

The installer keeps the `appId` and GUID, so the new build upgrades in place. The
executable becomes `Bizamiz.exe`, so the old "Business Suite Local Devices" firewall rule
(bound to the old executable) is removed on the next enable/disable and on uninstall, and
a new "Bizamiz Local Devices" rule is created when local devices are enabled again.
Data is untouched (see `userData` above).
