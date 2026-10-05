package uk.co.siamepos.spa;

import com.getcapacitor.BridgeActivity;

// PLAY-CLOSED-001 — the sideload APK registers nothing extra (it keeps the APK link / QR in Admin → Mobile App).
final class Channel {
    static void registerPlugins(BridgeActivity a) { }
}
