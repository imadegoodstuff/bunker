import type { CapacitorConfig } from "@capacitor/cli";

// The app is the live site in a WebView. Nothing is bundled: the web app,
// proving keys and SDK come from bunkeronbnb.com, so an update to the site is
// an update to the app. Keys live in the WebView's storage inside the app
// sandbox; proofs are generated on the phone.
const config: CapacitorConfig = {
  appId: "com.bunkeronbnb.wallet",
  appName: "BUNKER",
  webDir: "www",
  server: {
    url: process.env.BUNKER_APP_URL ?? "https://bunkeronbnb.com/app",
    androidScheme: "https",
    // navigation stays inside the site; everything else (bscscan, PancakeSwap, GitHub) opens in the system browser
    allowNavigation: ["bunkeronbnb.com", "*.bunkeronbnb.com", "bunker-app.fly.dev"],
  },
  android: {
    backgroundColor: "#0b0b0c",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 0, backgroundColor: "#0b0b0c" },
  },
};

export default config;
