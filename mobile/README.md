# BUNKER for Android

A thin Android shell (Capacitor) around the BUNKER web app. The APK contains no
protocol code of its own: it opens `https://bunkeronbnb.com/app` in a WebView,
so the wallet, the proving keys and the SDK are the ones the site serves, and a
site update is an app update.

What makes it a wallet rather than a browser tab:

- **Device vault.** On first launch the app creates a random spending seed and
  keeps it in the WebView's storage inside the app sandbox (`allowBackup` is
  off, so it never goes to cloud backup). A built-in BNB account is derived
  from the same seed and acts as the connected wallet: fund it, shield from
  it, and it pays claim gas on the launchpad. One backup string
  (`bunkerseed1…`) restores both.
- **Proofs on the phone.** Groth16 proving runs in the WebView (WASM); nothing
  secret leaves the device. The relayer only ever receives a finished proof.
- **No wallet app required.** No MetaMask, no WalletConnect, no browser
  extension. The same "This device" flow also works in any mobile browser at
  bunkeronbnb.com, and the site installs as a PWA.

## Get the APK

**https://bunkeronbnb.com/android** — the site serves `/download/bunker-android.apk`
and `/download/bunker-android.apk.sha256`. Every push to `mobile/` builds the
APK in CI and publishes it to the GitHub release tagged `android-latest`, which
is what the site streams. Install (allow "unknown sources" for the browser you
downloaded with) and verify against the checksum.

For a Play-store-grade signed release, set these repository secrets and the
workflow signs with them: `BUNKER_KEYSTORE_BASE64`, `BUNKER_KEYSTORE_PASSWORD`,
`BUNKER_KEY_ALIAS`, `BUNKER_KEY_PASSWORD`. Without them the APK is a debug
build (signed with the Android debug key), which installs fine for sideloading
but cannot be published to the store.

## Build locally

Needs JDK 17+ and the Android SDK (Android Studio installs both).

```sh
cd mobile
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
```

`npx cap open android` opens the project in Android Studio. To point the shell
at a staging site: `BUNKER_APP_URL=https://bunker-app.fly.dev/app npx cap sync android`.

## iOS (TestFlight)

The same shell, same device vault, same on-device proving. `mobile/ios` is the
Capacitor iOS project with our icon, splash, portrait-only Info.plist and an
`AppDelegate` that excludes the WebView's data from iCloud backup (the iOS
counterpart of Android's `allowBackup=false`).

`.github/workflows/ios.yml` runs on every push to `mobile/`:

- always: compiles an unsigned device build on a macOS runner, so the project
  is known to build;
- with Apple secrets: archives, signs and uploads straight to App Store
  Connect, where the build shows up in TestFlight after processing.

To turn on TestFlight uploads you need an Apple Developer Program membership
($99/yr) and, in App Store Connect, an app record with bundle id
`com.bunkeronbnb.wallet` and an API key (Users and Access → Integrations →
App Store Connect API, role App Manager). Then add these repository secrets:

| secret | value |
|---|---|
| `APPLE_TEAM_ID` | the 10-character team id |
| `ASC_KEY_ID` | API key id |
| `ASC_ISSUER_ID` | API issuer id |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_<KEY_ID>.p8` |
| `APPLE_CERT_P12_BASE64` | optional: Apple Distribution cert + key as .p12, base64 |
| `APPLE_CERT_PASSWORD` | optional: its password |

Without the `.p12`, Xcode creates a distribution certificate through the API
key on the first run. Builds are numbered from the workflow run number, so each
push is a new TestFlight build. Add testers in App Store Connect → TestFlight.

Local: `npx cap open ios` on a Mac with Xcode; or `cd ios/App && pod install && xcodebuild -workspace App.xcworkspace -scheme App build`.

## Layout

```
capacitor.config.ts   app id com.bunkeronbnb.wallet, server.url, allowed hosts
www/                  offline placeholder shown only if the site is unreachable
android/              generated Capacitor project; icons, splash and manifest are ours
ios/                  generated Capacitor project; icon, splash, Info.plist, AppDelegate, ExportOptions are ours
```
