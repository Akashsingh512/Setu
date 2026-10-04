package org.artofliving.setu;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        // Offers a newer Setu APK when one is published (see UpdateChecker).
        UpdateChecker.onResume(this);
    }
}
