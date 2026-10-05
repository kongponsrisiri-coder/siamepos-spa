package uk.co.siamepos.spa;

import com.getcapacitor.BridgeActivity;

final class Channel {
    static void registerPlugins(BridgeActivity a) { a.registerPlugin(PlayStorePlugin.class); }
}
