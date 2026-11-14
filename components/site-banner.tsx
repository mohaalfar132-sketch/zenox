import { Ionicons } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { getApiBaseUrl } from "@/constants/oauth";

/**
 * Live announcement from the owner center, drawn as an overlay on top of every
 * page. One sentence in the console changes it; no code edit, no rebuild.
 */

type Controls = {
  banner: {
    enabled: boolean;
    text: string;
    tone: "info" | "warning" | "danger";
    alarm: boolean;
    expiresAt: string | null;
  };
  maintenance: { enabled: boolean; message: string };
  announcement: { enabled: boolean; title: string; body: string };
};

const TONE = {
  info: { bg: "#0B2338", border: "#38BDF8", text: "#E0F2FE", icon: "information-circle" as const },
  warning: { bg: "#2A1F07", border: "#FBBF24", text: "#FEF3C7", icon: "alert-circle" as const },
  danger: { bg: "#2B0A12", border: "#FB7185", text: "#FFE4E6", icon: "warning" as const },
};

/** Three rising siren sweeps, no audio file. False when the browser blocked it. */
async function playSiren(): Promise<boolean> {
  const global = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctx = global.AudioContext ?? global.webkitAudioContext;
  if (!Ctx) return false;
  const ctx = new Ctx();
  try {
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") {
      await ctx.close();
      return false;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.connect(gain);
    const start = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.08);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const at = start + sweep * 0.75;
      osc.frequency.setValueAtTime(620, at);
      osc.frequency.linearRampToValueAtTime(1120, at + 0.37);
      osc.frequency.linearRampToValueAtTime(620, at + 0.74);
    }
    gain.gain.setValueAtTime(0.16, start + 2.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 2.3);
    osc.start(start);
    osc.stop(start + 2.35);
    osc.onended = () => void ctx.close();
    return true;
  } catch {
    await ctx.close().catch(() => undefined);
    return false;
  }
}

export function SiteBanner() {
  const [controls, setControls] = useState<Controls | null>(null);
  const [needTap, setNeedTap] = useState(false);
  const pathname = usePathname();
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/site/state`, { credentials: "include" });
        if (!response.ok) return;
        const data = (await response.json()) as Controls;
        if (active) setControls(data);
      } catch {
        // A network blip must never break the page.
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const banner = controls?.banner;
  const alarmOn = Boolean(banner?.enabled && banner.alarm);
  const stamp = banner?.text ?? "";

  useEffect(() => {
    if (!alarmOn) {
      setNeedTap(false);
      flash.setValue(0);
      return;
    }
    let active = true;
    void playSiren().then((played) => {
      if (active) setNeedTap(!played);
    });
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(flash, { toValue: 1, duration: 300, useNativeDriver: false }),
        Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: false }),
      ]),
    );
    loop.start();
    // The screen flashes red while the alarm is fresh, then stays calm.
    const stop = setTimeout(() => loop.stop(), 20_000);
    return () => {
      active = false;
      clearTimeout(stop);
      loop.stop();
    };
  }, [alarmOn, stamp, flash]);

  if (!controls) return null;
  if ((pathname ?? "").startsWith("/console")) return null;

  const tone = TONE[banner?.tone ?? "info"];
  const showBanner = Boolean(banner?.enabled && banner.text);
  if (!showBanner && !controls.maintenance.enabled) return null;

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <Animated.View
        pointerEvents="none"
        style={[styles.redFlash, { opacity: flash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.3] }) }]}
      />
      {controls.maintenance.enabled ? (
        <View style={styles.maintenance}>
          <Ionicons name="construct" size={22} color="#FBBF24" />
          <Text style={styles.maintenanceText}>{controls.maintenance.message || "الموقع في صيانة قصيرة."}</Text>
        </View>
      ) : null}
      {showBanner ? (
        <View style={[styles.banner, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Ionicons name={tone.icon} size={22} color={tone.text} />
          <Text style={[styles.bannerText, { color: tone.text }]}>{banner!.text}</Text>
          {banner!.alarm ? (
            <Pressable
              accessibilityLabel="تشغيل صوت الإنذار"
              onPress={() => void playSiren().then((played) => setNeedTap(!played))}
              style={[styles.alarmButton, needTap && styles.alarmButtonAttention]}
            >
              <Ionicons name="volume-high" size={18} color={tone.text} />
              <Text style={[styles.alarmText, { color: tone.text }]}>إنذار</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    ...Platform.select({ web: { pointerEvents: "box-none" as const }, default: {} }),
  },
  redFlash: { position: "absolute", top: 0, left: 0, right: 0, bottom: -2000, backgroundColor: "#DC2626" },
  banner: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    borderWidth: 2,
    borderRadius: 6,
    borderTopWidth: 0,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginHorizontal: 0,
  },
  bannerText: { flex: 1, fontSize: 17, fontWeight: "900", textAlign: "right", lineHeight: 26 },
  alarmButton: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: "#FBBF24",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  alarmButtonAttention: { backgroundColor: "rgba(251,191,36,0.25)" },
  alarmText: { fontSize: 12, fontWeight: "900" },
  maintenance: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#FBBF24",
    backgroundColor: "#221A08",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  maintenanceText: { flex: 1, color: "#FEF3C7", fontSize: 13, fontWeight: "800", textAlign: "right" },
});
