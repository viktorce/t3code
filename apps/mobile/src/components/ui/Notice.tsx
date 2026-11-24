import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { GlassSurface } from "./GlassSurface";

export function Notice(props: {
  readonly message: string;
  readonly action?: {
    readonly title?: string;
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly tone?: "default" | "danger";
  readonly icon?: AppSymbolName;
  readonly iconTone?: "default" | "danger";
  readonly floating?: boolean;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
}) {
  const gt = useGT();
  const danger = props.tone === "danger";
  const hasAction = props.action !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces the message to VoiceOver through AccessibilityInfo
  useEffect(() => {
    // Live regions reach TalkBack; VoiceOver needs an explicit announcement for passive notices.
    if (!hasAction && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(props.message);
  }, [hasAction, props.message]);

  const content = (
    <View className="flex-row items-start gap-3">
      {props.icon ? (
        <View className="pt-0.5">
          <SymbolView
            name={props.icon}
            size={16}
            tintColorClassName={
              danger || props.iconTone === "danger"
                ? "accent-danger-foreground"
                : "accent-icon-muted"
            }
          />
        </View>
      ) : null}
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.action.accessibilityLabel}
          onPress={props.action.onPress}
          className="min-w-0 flex-1 active:opacity-70"
        >
          {props.action.title ? (
            <AppText
              textRole="caption"
              className={cn(
                "font-t3-medium",
                danger ? "text-danger-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {props.action.title}
            </AppText>
          ) : null}
          <AppText
            textRole="footnote"
            numberOfLines={2}
            className={cn(
              danger ? "text-danger-foreground" : "text-foreground",
              !props.floating && "font-t3-medium",
            )}
          >
            {props.message}
          </AppText>
        </Pressable>
      ) : (
        <AppText
          selectable
          textRole="footnote"
          accessibilityLiveRegion="polite"
          className={cn(
            "min-w-0 flex-1",
            danger ? "text-danger-foreground" : "text-foreground",
            !props.floating && "font-t3-medium",
          )}
        >
          {props.message}
        </AppText>
      )}
      {props.onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.dismissLabel ?? gt("Dismiss message")}
          onPress={props.onDismiss}
          hitSlop={10}
          className="min-h-6 min-w-6 items-center justify-center active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName={danger ? "accent-danger-foreground" : "accent-icon-muted"}
          />
        </Pressable>
      ) : null}
    </View>
  );
  if (props.floating && Platform.OS === "ios")
    return (
      <GlassSurface className="p-4" style={{ borderRadius: 20 }}>
        {content}
      </GlassSurface>
    );
  return (
    <View
      className={cn(
        "rounded-2xl border px-3.5 py-3",
        danger ? "border-danger-border bg-danger" : "border-border bg-card",
        props.floating && "p-4",
      )}
    >
      {content}
    </View>
  );
}
