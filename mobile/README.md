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

Every push to `mobile/` builds one in CI and publishes it to the GitHub
release tagged `android-latest`. Download `bunker-android.apk`, check it
against `bunker-android.apk.sha256`, install (allow "unknown sources" for the
browser you downloaded with).

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

## Layout

```
capacitor.config.ts   app id com.bunkeronbnb.wallet, server.url, allowed hosts
www/                  offline placeholder shown only if the site is unreachable
android/              generated Capacitor project; icons, splash and manifest are ours
```
