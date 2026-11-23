import { assistantCitationLabel } from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { Notice } from "../../components/ui/Notice";
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

  const subagentTitles = replyTo.subagents?.length
    ? replyTo.subagents.map((subagent) => subagent.title).join(", ")
    : null;
  const title = subagentTitles
    ? gt("Replying to {titles}", { titles: subagentTitles })
    : gt("Replying to", { $context: "banner title; the message being replied to follows" });
  const body = assistantCitationLabel(replyTo.citation);
  const pressAccessibilityLabel = subagentTitles
    ? gt("Replying to {titles}: {preview}", {
        titles: subagentTitles,
        preview: body,
        $context: "button accessibility label; jumps to the response being replied to",
      })
    : gt("Replying to: {preview}", {
        preview: body,
        $context: "button accessibility label; jumps to the response being replied to",
      });

  return (
    <Animated.View
      className="shrink-0 px-4 pb-3"
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
    >
      <Notice
        title={title}
        message={body}
        messageNumberOfLines={2}
        icon="arrowshape.turn.up.left"
        floating
        announce={false}
        pressAccessibilityLabel={pressAccessibilityLabel}
        onPress={() => {
          requestThreadMessageJump(
            scopedThreadKey(replyTo.citation.environmentId, replyTo.citation.threadId),
            replyTo.citation.messageId,
          );
        }}
        onDismiss={() => setComposerDraftReplyTo(props.draftKey, null)}
        dismissLabel={gt("Cancel reply")}
        dismissDisabled={props.disabled}
      />
    </Animated.View>
  );
}
