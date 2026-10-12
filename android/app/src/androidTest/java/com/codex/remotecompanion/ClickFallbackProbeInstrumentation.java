package com.codex.remotecompanion;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.json.JSONArray;

/** Emulator-only probe: official accessibility gesture fallback, zero orders. */
public final class ClickFallbackProbeInstrumentation extends Instrumentation {
 @Override public void onCreate(Bundle arguments) {super.onCreate(arguments);start();}
 @Override public void onStart() { run(this); }
 public static void run(Instrumentation self) {
  Bundle result=new Bundle();AtomicInteger clicks=new AtomicInteger();
  try {
   self.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
   Intent intent=new Intent(self.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
   Activity activity=self.startActivitySync(intent);
   self.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
   // Instrumentation stops the target process at startup, including its
   // accessibility service. Rebind that service on the dedicated test emulator.
   android.app.UiAutomation automation=self.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
   automation.executeShellCommand("settings put secure enabled_accessibility_services ''").close();
   SystemClock.sleep(1000);
   automation.executeShellCommand("settings put secure enabled_accessibility_services com.codex.remotecompanion/com.codex.remotecompanion.ControlAccessibilityService").close();
   automation.executeShellCommand("settings put secure accessibility_enabled 1").close();
   TextView[] price=new TextView[1];
   self.runOnMainSync(()->{
    LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);box.setContentDescription("test-order");
    price[0]=new TextView(activity);price[0].setText("KRW 99,000");box.addView(price[0],new LinearLayout.LayoutParams(-1,150));
    Button button=new Button(activity){
     @Override public boolean performAccessibilityAction(int action,Bundle args){
      if(action==AccessibilityNodeInfo.ACTION_CLICK)return false;return super.performAccessibilityAction(action,args);
     }
    };
    button.setAllCaps(false);button.setText("Click fallback probe");button.setOnClickListener(v->clicks.incrementAndGet());box.addView(button,new LinearLayout.LayoutParams(-1,150));activity.setContentView(box);
   });
   ControlAccessibilityService service=null;long deadline=SystemClock.elapsedRealtime()+10000;
   while(SystemClock.elapsedRealtime()<deadline){service=ControlAccessibilityService.getInstance();try{if(service!=null&&service.snapshot().toString().contains("Click fallback probe"))break;}catch(IllegalStateException transientRoot){}SystemClock.sleep(100);}
   if(service==null)throw new AssertionError("Test accessibility service unavailable");
   JSONObject guard=new JSONObject().put("expectedPackage","com.codex.remotecompanion")
    .put("root",new JSONObject().put("contentDescription","test-order"))
    .put("nodes",new JSONArray().put(new JSONObject().put("text","KRW 99,000")));
   JSONObject selector=new JSONObject().put("text","Click fallback probe").put("expectedPackage","com.codex.remotecompanion").put("guard",guard);
   result.putString("snapshot_before",service.snapshot().toString());
   boolean performed=service.click(selector);
   SystemClock.sleep(500);
   result.putBoolean("performed",performed);result.putInt("effects_observed",clicks.get());
   if(!performed)throw new AssertionError("Gesture fallback not performed");
   SystemClock.sleep(150);if(clicks.get()!=1)throw new AssertionError("Expected exactly one effect: "+clicks.get());
   self.runOnMainSync(()->price[0].setText("KRW 199,000"));SystemClock.sleep(100);
   boolean rejected=false;try{service.click(selector);}catch(IllegalStateException expected){rejected=expected.getMessage().contains("Atomic UI guard changed");}
   if(!rejected||clicks.get()!=1)throw new AssertionError("Changed-price guard allowed another effect");
   result.putString("click_fallback_result","PASS");result.putInt("effects",clicks.get());self.finish(-1,result);
  }catch(Throwable e){result.putString("click_fallback_result","FAIL: "+e);self.finish(0,result);}
 }
}
