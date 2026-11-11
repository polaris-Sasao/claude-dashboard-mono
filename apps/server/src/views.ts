// 詳細パネルの API

import type { GroupView, SessionDetail, TodoItem, TurnView } from "@kanseishitsu/shared";

/**
 * 詳細パネル。セッションと見出しは、ファイルから作った一覧（groups）から取る。
 * プロンプトと応答の組・ToDo は、会話記録から作ったもの（local/conversation.ts）を渡す
 */
export function sessionDetail(
  groups: GroupView[],
  sessionId: string,
  turns: TurnView[] = [],
  moreTurns = false,
  todos: TodoItem[] | null = null,
): SessionDetail | null {
  const group = groups.find((g) => g.sessions.some((s) => s.sessionId === sessionId));
  const session = group?.sessions.find((s) => s.sessionId === sessionId);
  if (!group || !session) return null;
  return { session, groupLabel: group.label, groupSub: group.sub, turns, moreTurns, todos };
}
