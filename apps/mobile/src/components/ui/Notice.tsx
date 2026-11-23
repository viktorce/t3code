import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { GlassSurface } from "./GlassSurface";

export function Notice(props: {
  readonly title?: string;
  readonly message: string;
  readonly messageNumberOfLines?: number;
  readonly onPress?: () => void;
  readonly pressAccessibilityLabel?: string;
  readonly announce?: boolean;
  readonly tone?: "default" | "danger";
  readonly icon?: AppSymbolName;
  readonly iconTone?: "default" | "danger";
  readonly floating?: boolean;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly dismissDisabled?: boolean;
}) {
  const gt = useGT();
  const danger = props.tone === "danger";
  const announce = props.announce ?? true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces the message to VoiceOver through AccessibilityInfo
  useEffect(() => {
    // Live regions reach TalkBack; VoiceOver needs an explicit announcement.
    if (announce && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(props.message);
  }, [announce, props.message]);

  const body = (
    <>
      {props.title ? (
        <AppText
          textRole="caption"
          className={cn(
            "font-t3-medium",
            danger ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.title}
        </AppText>
      ) : null}
      <AppText
        selectable={!props.onPress}
        textRole="footnote"
        accessibilityLiveRegion={announce ? "polite" : "none"}
        numberOfLines={props.messageNumberOfLines}
        className={cn(
          !props.title && !props.onPress && "min-w-0 flex-1",
          danger ? "text-danger-foreground" : "text-foreground",
          !props.floating && "font-t3-medium",
        )}
      >
        {props.message}
      </AppText>
    </>
  );

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
      {props.onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.pressAccessibilityLabel}
          onPress={props.onPress}
          className="min-w-0 flex-1 active:opacity-70"
        >
          {body}
        </Pressable>
      ) : props.title ? (
        <View className="min-w-0 flex-1">{body}</View>
      ) : (
        body
      )}
      {props.onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.dismissLabel ?? gt("Dismiss message")}
          disabled={props.dismissDisabled}
          onPress={props.onDismiss}
          hitSlop={10}
          className="min-h-6 min-w-6 items-center justify-center active:opacity-60 disabled:opacity-40"
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
