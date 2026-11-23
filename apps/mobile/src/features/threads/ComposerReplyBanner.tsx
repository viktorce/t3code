import { assistantCitationLabel } from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react-native";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { setComposerDraftReplyTo, useComposerDraftReplyTo } from "../../state/use-composer-drafts";
import { requestThreadMessageJump } from "./threadMessageJump";

export function ComposerReplyBanner(props: {
  readonly draftKey: string;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const replyTo = useComposerDraftReplyTo(props.draftKey);
  if (replyTo === null) return null;

  const title = replyTo.subagents?.length
    ? gt("Replying to {titles}", {
        titles: replyTo.subagents.map((subagent) => subagent.title).join(", "),
      })
    : gt("Replying to", { $context: "banner title; the message being replied to follows" });
  const body = assistantCitationLabel(replyTo.citation);
  const jumpToResponse = () => {
    requestThreadMessageJump(
      scopedThreadKey(replyTo.citation.environmentId, replyTo.citation.threadId),
      replyTo.citation.messageId,
    );
  };

  const content = (
    <View className="flex-row items-center gap-3">
      <SymbolView name="arrowshape.turn.up.left" size={15} tintColorClassName="accent-icon-muted" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${body}`}
        onPress={jumpToResponse}
        className="min-w-0 flex-1 active:opacity-70"
      >
        <AppText
          textRole="caption"
          className="font-t3-medium text-foreground-muted"
          numberOfLines={1}
        >
          {title}
        </AppText>
        <AppText textRole="footnote" className="text-foreground" numberOfLines={2}>
          {body}
        </AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Cancel reply")}
        disabled={props.disabled}
        onPress={() => setComposerDraftReplyTo(props.draftKey, null)}
        hitSlop={10}
        className="min-h-6 min-w-6 items-center justify-center active:opacity-60 disabled:opacity-40"
      >
        <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </View>
  );

  return (
    <Animated.View
      className="shrink-0 px-4 pb-3"
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
    >
      {Platform.OS === "ios" ? (
        <GlassSurface className="px-3.5 py-2.5" style={{ borderRadius: 20 }}>
          {content}
        </GlassSurface>
      ) : (
        <View className="rounded-2xl border border-border bg-card px-3.5 py-2.5">{content}</View>
      )}
    </Animated.View>
  );
}
