import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentMessageSchema,
  agentSettingsSchema,
  harnessSchema,
  type AgentMessage,
  type HarnessKind,
} from '../../contracts/agent';
const nativeIds = z
  .object({
    opencode: z.string().min(1).max(160).optional(),
    codex: z.string().min(1).max(160).optional(),
  })
  .strict();
const settings = z
  .object({ opencode: agentSettingsSchema.optional(), codex: agentSettingsSchema.optional() })
  .strict();
export const conversationSchema = z
  .object({
    id: z.string().min(1).max(160),
    harness: harnessSchema,
    title: z.string().max(300),
    titleEdited: z.boolean().optional(),
    settings: agentSettingsSchema.optional(),
    nativeSessions: nativeIds.optional(),
    nativeSettings: settings.optional(),
    pendingHandoff: z.array(harnessSchema).max(2).optional(),
    history: z.array(agentMessageSchema).max(200).optional(),
    seenMessages: z.array(z.string().max(48)).max(50000).optional(),
  })
  .strict();
export type ConversationRef = z.infer<typeof conversationSchema>;
export function readConversations(raw: unknown) {
  const input = z
    .object({
      version: z.union([z.literal(1), z.literal(2)]),
      sessions: z.array(conversationSchema).max(100),
      sessionId: z.string().max(160).nullable().optional(),
      harness: harnessSchema.optional(),
    })
    .strict()
    .parse(raw);
  return {
    ...input,
    sessions: input.sessions.map((ref) => ({
      ...ref,
      nativeSessions: ref.nativeSessions ?? { [ref.harness]: ref.id },
      nativeSettings: ref.nativeSettings ?? { [ref.harness]: ref.settings },
      history: ref.history ?? [],
    })),
  };
}
export function nativeSessionKey(harness: HarnessKind, nativeId: string) {
  return harness + ':' + createHash('sha256').update(nativeId).digest('hex').slice(0, 32);
}
export function mergeConversation(
  ref: ConversationRef,
  harness: HarnessKind,
  nativeId: string,
  messages: AgentMessage[],
) {
  const history = [...(ref.history ?? [])];
  const seen = new Set([...(ref.seenMessages ?? []), ...history.map((message) => message.id)]);
  for (const message of messages) {
    const id = nativeSessionKey(harness, nativeId + '\0' + message.id);
    const entry = { ...message, id, harness };
    const index = history.findIndex((existing) => existing.id === id);
    if (index >= 0) history[index] = entry;
    else if (!seen.has(id)) {
      if (seen.size >= 50000)
        throw new Error(
          'This conversation has reached its local history limit. Start a new conversation to continue; native agent history is preserved.',
        );
      history.push(entry);
      seen.add(id);
    }
  }
  ref.seenMessages = [...seen];
  // Public conversation excerpts are bounded independently of harness-owned history.
  let length = 0;
  ref.history = history
    .slice(-200)
    .reverse()
    .filter((message) => {
      length += message.text.length;
      return length <= 300000;
    })
    .reverse();
  return ref.history;
}
