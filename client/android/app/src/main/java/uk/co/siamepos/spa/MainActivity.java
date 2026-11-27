package uk.co.siamepos.spa;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        Channel.registerPlugins(this);   // PLAY-CLOSED-001 — the Play build registers the PlayStore marker
        super.onCreate(savedInstanceState);
    }
}
